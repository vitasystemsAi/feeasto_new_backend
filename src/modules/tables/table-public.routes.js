const express = require("express");
const { z } = require("zod");
const pool = require("../../db/pool");
const { validateIndianPhone } = require("../../utils/phone");
const {
  ensureQrGuestUser,
  upsertTableCustomer,
} = require("./ensureTableQrSchema");

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

async function loadTableByToken(token) {
  const [[row]] = await pool.execute(
    `SELECT rt.id AS table_id, rt.table_number, rt.capacity, rt.status AS table_status,
            rt.tenant_id, rt.restaurant_id, rt.qr_token,
            r.name AS restaurant_name, r.is_online, r.approval_status, r.is_active
     FROM restaurant_tables rt
     INNER JOIN restaurants r ON r.id = rt.restaurant_id
     WHERE rt.qr_token = ?
     LIMIT 1`,
    [token]
  );
  return row || null;
}

function tablePublicRoutes(io) {
  const router = express.Router();

  router.get("/:token", async (req, res) => {
    const token = String(req.params.token || "").trim();
    if (!token || token.length < 16) {
      return res.status(400).json({ message: "Invalid table QR code" });
    }

    try {
      const table = await loadTableByToken(token);
      if (!table) return res.status(404).json({ message: "Table QR not found" });
      if (Number(table.is_active) === 0 || String(table.approval_status || "").toUpperCase() !== "APPROVED") {
        return res.status(403).json({ message: "This restaurant is not available for ordering right now." });
      }

      let menuRows;
      try {
        [menuRows] = await pool.execute(
          `SELECT mi.id, mi.category_id, mi.name, mi.description, mi.price, mi.is_veg,
                  COALESCE(mi.is_available, 1) AS is_available, mi.available_stock,
                  mc.name AS category_name
           FROM menu_items mi
           INNER JOIN menu_categories mc ON mc.id = mi.category_id
           WHERE mi.restaurant_id = ? AND mi.tenant_id = ? AND mi.is_active = 1
           ORDER BY mc.name ASC, mi.name ASC`,
          [table.restaurant_id, table.tenant_id]
        );
      } catch (error) {
        if (error?.code === "ER_BAD_FIELD_ERROR") {
          [menuRows] = await pool.execute(
            `SELECT mi.id, mi.category_id, mi.name, mi.description, mi.price, mi.is_veg,
                    1 AS is_available, mi.available_stock, mc.name AS category_name
             FROM menu_items mi
             INNER JOIN menu_categories mc ON mc.id = mi.category_id
             WHERE mi.restaurant_id = ? AND mi.tenant_id = ? AND mi.is_active = 1
             ORDER BY mc.name ASC, mi.name ASC`,
            [table.restaurant_id, table.tenant_id]
          );
        } else {
          throw error;
        }
      }

      const items = (menuRows || [])
        .filter((it) => Number(it.is_available) !== 0)
        .map((it) => ({
          id: it.id,
          category_id: it.category_id,
          category_name: it.category_name,
          name: it.name,
          description: it.description,
          price: Number(it.price),
          is_veg: Boolean(it.is_veg),
          available_stock: it.available_stock,
        }));

      const categoriesMap = new Map();
      for (const it of items) {
        if (!categoriesMap.has(it.category_id)) {
          categoriesMap.set(it.category_id, {
            id: it.category_id,
            name: it.category_name,
          });
        }
      }

      return res.json({
        table: {
          id: table.table_id,
          tableNumber: table.table_number,
          capacity: table.capacity,
          status: table.table_status,
        },
        restaurant: {
          id: table.restaurant_id,
          name: table.restaurant_name,
          isOnline: Number(table.is_online) !== 0,
        },
        categories: [...categoriesMap.values()],
        items,
      });
    } catch (error) {
      return res.status(500).json({ message: "Failed to load table menu", details: error.message });
    }
  });

  router.post("/:token/order", async (req, res) => {
    const token = String(req.params.token || "").trim();
    if (!token || token.length < 16) {
      return res.status(400).json({ message: "Invalid table QR code" });
    }

    const schema = z.object({
      customerName: z.string().trim().min(2).max(120),
      customerPhone: z.string().trim().min(10).max(20),
      items: z
        .array(
          z.object({
            menuItemId: z.coerce.number().int().positive(),
            quantity: z.coerce.number().int().positive().max(50),
          })
        )
        .min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });

    const phoneCheck = validateIndianPhone(parsed.data.customerPhone);
    if (!phoneCheck.ok) return res.status(400).json({ message: phoneCheck.message });

    const customerName = parsed.data.customerName.trim();
    const phone = phoneCheck.phone;

    let table;
    try {
      table = await loadTableByToken(token);
    } catch (error) {
      return res.status(500).json({ message: "Failed to resolve table", details: error.message });
    }
    if (!table) return res.status(404).json({ message: "Table QR not found" });
    if (Number(table.is_active) === 0 || String(table.approval_status || "").toUpperCase() !== "APPROVED") {
      return res.status(403).json({ message: "This restaurant is not available for ordering right now." });
    }
    if (Number(table.is_online) === 0) {
      return res.status(403).json({ message: "Restaurant is offline. Please ask staff for help." });
    }

    let guestUserId;
    try {
      guestUserId = await ensureQrGuestUser(table.tenant_id);
    } catch (error) {
      return res.status(500).json({ message: "Failed to prepare guest session", details: error.message });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [[locked]] = await conn.execute(
        "SELECT id, table_number, tenant_id, restaurant_id, status FROM restaurant_tables WHERE id = ? LIMIT 1 FOR UPDATE",
        [table.table_id]
      );
      if (!locked) {
        await conn.rollback();
        return res.status(404).json({ message: "Table QR not found" });
      }

      let orderId;
      let created = false;
      const [[existing]] = await conn.execute(
        `SELECT id FROM orders
         WHERE tenant_id = ? AND restaurant_id = ? AND table_id = ?
           AND order_type = 'DINE_IN'
           AND status IN ('PLACED','ACCEPTED','PREPARING','READY')
         ORDER BY id DESC
         LIMIT 1
         FOR UPDATE`,
        [locked.tenant_id, locked.restaurant_id, locked.id]
      );

      if (existing) {
        orderId = existing.id;
        try {
          await conn.execute(
            "UPDATE orders SET guest_name = ?, customer_contact_phone = ? WHERE id = ?",
            [customerName, phone, orderId]
          );
        } catch (error) {
          if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
          await conn.execute("UPDATE orders SET customer_contact_phone = ? WHERE id = ?", [phone, orderId]);
        }
      } else {
        try {
          const [createdOrder] = await conn.execute(
            `INSERT INTO orders
              (tenant_id, restaurant_id, customer_user_id, table_id, order_type, status, customer_contact_phone, guest_name)
             VALUES (?, ?, ?, ?, 'DINE_IN', 'ACCEPTED', ?, ?)`,
            [locked.tenant_id, locked.restaurant_id, guestUserId, locked.id, phone, customerName]
          );
          orderId = createdOrder.insertId;
          created = true;
        } catch (error) {
          if (error?.code === "ER_BAD_FIELD_ERROR") {
            const [createdOrder] = await conn.execute(
              `INSERT INTO orders
                (tenant_id, restaurant_id, customer_user_id, table_id, order_type, status, customer_contact_phone)
               VALUES (?, ?, ?, ?, 'DINE_IN', 'ACCEPTED', ?)`,
              [locked.tenant_id, locked.restaurant_id, guestUserId, locked.id, phone]
            );
            orderId = createdOrder.insertId;
            created = true;
          } else {
            throw error;
          }
        }
      }

      const placedItems = [];
      for (const item of parsed.data.items) {
        let menuItem;
        try {
          const [[row]] = await conn.execute(
            `SELECT id, name, price, COALESCE(is_available, 1) AS is_available, is_active
             FROM menu_items
             WHERE id = ? AND restaurant_id = ? AND tenant_id = ?
             LIMIT 1`,
            [item.menuItemId, locked.restaurant_id, locked.tenant_id]
          );
          menuItem = row;
        } catch (error) {
          if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
          const [[row]] = await conn.execute(
            `SELECT id, name, price, 1 AS is_available, is_active
             FROM menu_items
             WHERE id = ? AND restaurant_id = ? AND tenant_id = ?
             LIMIT 1`,
            [item.menuItemId, locked.restaurant_id, locked.tenant_id]
          );
          menuItem = row;
        }
        if (!menuItem || Number(menuItem.is_active) === 0 || Number(menuItem.is_available) === 0) {
          await conn.rollback();
          return res.status(400).json({
            message: `Item unavailable: ${menuItem?.name || item.menuItemId}`,
          });
        }
        await conn.execute(
          "INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price) VALUES (?, ?, ?, ?)",
          [orderId, menuItem.id, item.quantity, menuItem.price]
        );
        placedItems.push({
          menu_item_id: menuItem.id,
          menu_item_name: menuItem.name,
          quantity: item.quantity,
          unit_price: Number(menuItem.price),
        });
      }

      try {
        await conn.execute(
          "UPDATE restaurant_tables SET status = 'OCCUPIED', reserved_from = NULL, reserved_to = NULL WHERE id = ? AND tenant_id = ?",
          [locked.id, locked.tenant_id]
        );
      } catch (error) {
        if (error?.code !== "ER_BAD_FIELD_ERROR") throw error;
        await conn.execute(
          "UPDATE restaurant_tables SET status = 'OCCUPIED' WHERE id = ? AND tenant_id = ?",
          [locked.id, locked.tenant_id]
        );
      }

      await conn.commit();

      await upsertTableCustomer({
        tenantId: locked.tenant_id,
        restaurantId: locked.restaurant_id,
        fullName: customerName,
        phone,
        tableId: locked.id,
        orderId,
      });

      const lineTotal = roundMoney(
        placedItems.reduce((sum, it) => sum + Number(it.quantity) * Number(it.unit_price), 0)
      );
      const itemCount = placedItems.reduce((sum, it) => sum + Number(it.quantity), 0);

      const alertPayload = {
        orderId: Number(orderId),
        status: "ACCEPTED",
        orderType: "DINE_IN",
        orderSource: "QR_TABLE",
        restaurantId: Number(locked.restaurant_id),
        tenantId: Number(locked.tenant_id),
        tableId: Number(locked.id),
        tableNumber: locked.table_number,
        customerName,
        customerPhone: phone,
        items: placedItems.slice(0, 4),
        itemCount,
        lineTotal,
        placedAt: new Date().toISOString(),
        requiresOwnerAction: false,
        notifyOnly: true,
      };

      io.to(`tenant:${locked.tenant_id}`).emit("order:table-qr", alertPayload);
      io.to(`tenant:${locked.tenant_id}`).emit("order:created", {
        orderId,
        status: "ACCEPTED",
        restaurantId: locked.restaurant_id,
        orderType: "DINE_IN",
        orderSource: "QR_TABLE",
        tableId: locked.id,
        tableNumber: locked.table_number,
        customerName,
        customerPhone: phone,
        requiresOwnerAction: false,
      });
      io.to(`tenant:${locked.tenant_id}`).emit("order:items-added", {
        orderId,
        restaurantId: locked.restaurant_id,
        orderType: "DINE_IN",
        orderSource: "QR_TABLE",
        tableId: locked.id,
      });
      io.to(`tenant:${locked.tenant_id}`).emit("table:updated", {
        tableId: locked.id,
        action: "OCCUPIED",
        status: "OCCUPIED",
        orderSource: "QR_TABLE",
      });

      return res.status(201).json({
        ok: true,
        orderId,
        created,
        tableNumber: locked.table_number,
        restaurantName: table.restaurant_name,
        customerName,
        customerPhone: phone,
        items: placedItems,
        lineTotal,
        message: "Order placed. Kitchen has been notified.",
      });
    } catch (error) {
      await conn.rollback();
      return res.status(500).json({ message: "Failed to place table order", details: error.message });
    } finally {
      conn.release();
    }
  });

  return router;
}

module.exports = tablePublicRoutes;
