/**
 * Parse / expand subscription delivery_days_json (shared by ops + customer flows).
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeSlotTime(t) {
  if (!t) return "12:00";
  const s = String(t).trim().slice(0, 5);
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return "12:00";
  return `${String(Number(m[1])).padStart(2, "0")}:${m[2]}`;
}

function parseScheduleObject(raw) {
  if (!raw) return { ranges: [], dates: [], assignments: [], cancelledSlots: [] };
  try {
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (Array.isArray(data)) {
      return { ranges: [], dates: data.filter((d) => ISO_DATE.test(d)), assignments: [], cancelledSlots: [] };
    }
    if (data && typeof data === "object") {
      return {
        ranges: Array.isArray(data.ranges) ? data.ranges : [],
        dates: Array.isArray(data.dates) ? data.dates.filter((d) => ISO_DATE.test(d)) : [],
        assignments: Array.isArray(data.assignments) ? data.assignments : [],
        cancelledSlots: Array.isArray(data.cancelledSlots) ? data.cancelledSlots : [],
      };
    }
  } catch {
    /* ignore */
  }
  return { ranges: [], dates: [], assignments: [], cancelledSlots: [] };
}

function expandScheduleDates(schedule) {
  const unique = new Set();
  for (const iso of schedule.dates || []) {
    if (ISO_DATE.test(iso)) unique.add(iso);
  }
  for (const range of schedule.ranges || []) {
    if (!range?.from || !range?.to || !ISO_DATE.test(range.from) || !ISO_DATE.test(range.to)) continue;
    const start = new Date(`${range.from}T12:00:00`);
    const end = new Date(`${range.to}T12:00:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) continue;
    const cursor = new Date(start);
    while (cursor <= end) {
      const y = cursor.getFullYear();
      const m = String(cursor.getMonth() + 1).padStart(2, "0");
      const d = String(cursor.getDate()).padStart(2, "0");
      unique.add(`${y}-${m}-${d}`);
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  for (const a of schedule.assignments || []) {
    if (a?.date && ISO_DATE.test(a.date)) unique.add(a.date);
  }
  return [...unique].sort();
}

function isDeliveryScheduledForDate(frequency, daysJson, isoDate) {
  if (!isoDate || !ISO_DATE.test(isoDate)) return false;
  const freq = String(frequency || "EVERY_DAY").toUpperCase();
  if (freq === "EVERY_DAY") return true;
  const d = new Date(`${isoDate}T12:00:00`);
  if (Number.isNaN(d.getTime())) return false;
  const dow = d.getDay();
  if (freq === "WEEKDAYS") return dow >= 1 && dow <= 5;
  if (freq === "CUSTOM") {
    const schedule = parseScheduleObject(daysJson);
    const dates = new Set(expandScheduleDates(schedule));
    return dates.has(isoDate);
  }
  return false;
}

function slotKey(date, time) {
  return `${date}|${normalizeSlotTime(time)}`;
}

function isSlotCancelled(schedule, date, time) {
  const key = slotKey(date, time);
  return (schedule.cancelledSlots || []).some((c) => slotKey(c.date, c.time) === key);
}

function deliverySlotDateTime(isoDate, time) {
  const t = normalizeSlotTime(time);
  return new Date(`${isoDate}T${t}:00`);
}

function hoursUntilSlot(isoDate, time) {
  const slot = deliverySlotDateTime(isoDate, time);
  return (slot.getTime() - Date.now()) / (1000 * 60 * 60);
}

/** Customer may change/cancel until this many hours before delivery time. */
function canModifySlot(isoDate, time, cutoffHours = 3) {
  return hoursUntilSlot(isoDate, time) > cutoffHours;
}

function todayIsoLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function buildPlanItemLines(planItems) {
  return (planItems || []).map((it) => ({
    menuItemId: Number(it.menu_item_id),
    menuItemName: it.menu_item_name || `Item #${it.menu_item_id}`,
    quantity: Math.max(1, Number(it.quantity) || 1),
  }));
}

function buildUpcomingSlots(subscriber, planItems, daysAhead = 28) {
  const schedule = parseScheduleObject(subscriber.delivery_days_json);
  const today = todayIsoLocal();
  const slots = [];
  const seen = new Set();

  const pushSlot = (date, time, items) => {
    if (!ISO_DATE.test(date) || date < today) return;
    if (isSlotCancelled(schedule, date, time)) return;
    const key = slotKey(date, time);
    if (seen.has(key)) return;
    seen.add(key);
    const lineItems =
      items?.length > 0
        ? items.map((i) => ({
            menuItemId: Number(i.menuItemId || i.menu_item_id),
            menuItemName: i.menuItemName || i.menu_item_name || `Item #${i.menuItemId}`,
            quantity: Math.max(1, Number(i.quantity) || 1),
          }))
        : buildPlanItemLines(planItems);
    if (!lineItems.length) return;
    slots.push({ date, time: normalizeSlotTime(time), items: lineItems });
  };

  const withAssignments = (schedule.assignments || []).filter(
    (a) => a?.date && ISO_DATE.test(a.date) && Array.isArray(a.items) && a.items.length
  );
  if (withAssignments.length) {
    for (const a of withAssignments) {
      pushSlot(a.date, a.time || "12:00", a.items);
    }
  } else {
    const start = new Date(`${today}T12:00:00`);
    for (let i = 0; i < daysAhead; i += 1) {
      const cursor = new Date(start);
      cursor.setDate(cursor.getDate() + i);
      const y = cursor.getFullYear();
      const m = String(cursor.getMonth() + 1).padStart(2, "0");
      const d = String(cursor.getDate()).padStart(2, "0");
      const iso = `${y}-${m}-${d}`;
      if (isDeliveryScheduledForDate(subscriber.delivery_frequency, subscriber.delivery_days_json, iso)) {
        pushSlot(iso, "12:00", null);
      }
    }
  }

  slots.sort((a, b) => {
    const da = deliverySlotDateTime(a.date, a.time).getTime();
    const db = deliverySlotDateTime(b.date, b.time).getTime();
    return da - db;
  });
  return slots;
}

function serializeSchedule(schedule) {
  return JSON.stringify({
    ranges: schedule.ranges || [],
    dates: schedule.dates || [],
    assignments: schedule.assignments || [],
    cancelledSlots: schedule.cancelledSlots || [],
  });
}

function updateAssignmentInSchedule(daysJson, date, time, mutator) {
  const schedule = parseScheduleObject(daysJson);
  const t = normalizeSlotTime(time);
  let idx = (schedule.assignments || []).findIndex((a) => a.date === date && normalizeSlotTime(a.time) === t);
  if (idx < 0) {
    schedule.assignments = schedule.assignments || [];
    schedule.assignments.push({ date, time: t, items: [] });
    idx = schedule.assignments.length - 1;
  }
  schedule.assignments[idx] = mutator(schedule.assignments[idx]);
  return serializeSchedule(schedule);
}

function addCancelledSlot(daysJson, date, time) {
  const schedule = parseScheduleObject(daysJson);
  const key = slotKey(date, time);
  schedule.cancelledSlots = schedule.cancelledSlots || [];
  if (!schedule.cancelledSlots.some((c) => slotKey(c.date, c.time) === key)) {
    schedule.cancelledSlots.push({ date, time: normalizeSlotTime(time) });
  }
  return serializeSchedule(schedule);
}

function rescheduleAssignment(daysJson, date, time, newDate, newTime) {
  const schedule = parseScheduleObject(daysJson);
  const t = normalizeSlotTime(time);
  const nt = normalizeSlotTime(newTime);
  const idx = (schedule.assignments || []).findIndex((a) => a.date === date && normalizeSlotTime(a.time) === t);
  if (idx >= 0) {
    const prev = schedule.assignments[idx];
    schedule.assignments[idx] = { ...prev, date: newDate, time: nt };
  } else {
    schedule.assignments = schedule.assignments || [];
    schedule.assignments.push({ date: newDate, time: nt, items: [] });
  }
  return serializeSchedule(schedule);
}

const LOCKED_ORDER_STATUSES = new Set(["PREPARING", "READY", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"]);

module.exports = {
  normalizeSlotTime,
  parseScheduleObject,
  expandScheduleDates,
  isDeliveryScheduledForDate,
  slotKey,
  isSlotCancelled,
  deliverySlotDateTime,
  hoursUntilSlot,
  canModifySlot,
  todayIsoLocal,
  buildUpcomingSlots,
  serializeSchedule,
  updateAssignmentInSchedule,
  addCancelledSlot,
  rescheduleAssignment,
  LOCKED_ORDER_STATUSES,
};
