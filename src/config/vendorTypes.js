/**
 * Master list of supported vendor/business types on the Feesto platform.
 *
 * Each entry:
 *   key            — unique slug stored in DB
 *   label          — human-readable name
 *   icon           — emoji shown in UI
 *   description    — short description shown in forms
 *   orderingConfig — default unit/ordering configuration for this vendor type:
 *     orderingMode   : "weight" | "piece" | "volume" | "pack" | "plate"
 *     defaultUnit    : the pre-selected unit when adding products
 *     allowedUnits   : all units the owner can choose per product
 *     portionOptions : quick-select portion sizes shown to customer at order time
 *     orderFlow      : step labels: ["items", "unit", "quantity", "order"]
 *     unitLabel      : label shown next to quantity input ("per kg", "per piece", etc.)
 */
const VENDOR_TYPES = [
  {
    key: "restaurant",
    label: "Restaurant",
    icon: "🍽️",
    description: "Full-service restaurant or food outlet",
    orderingConfig: {
      orderingMode: "plate",
      defaultUnit: "plate",
      allowedUnits: ["plate", "half", "full", "piece"],
      portionOptions: ["Half", "Full"],
      orderFlow: ["Dishes", "Portion", "Quantity", "Order"],
      unitLabel: "per plate",
    },
  },
  {
    key: "chicken_shop",
    label: "Chicken Shop",
    icon: "🍗",
    description: "Fresh chicken and poultry products",
    orderingConfig: {
      orderingMode: "weight",
      defaultUnit: "kg",
      allowedUnits: ["kg", "500g", "250g", "piece"],
      portionOptions: ["250 g", "500 g", "1 kg", "2 kg"],
      orderFlow: ["Items", "Weight / Piece", "Quantity", "Order"],
      unitLabel: "per kg / piece",
    },
  },
  {
    key: "mutton_shop",
    label: "Mutton Shop",
    icon: "🥩",
    description: "Fresh mutton, lamb and red meat",
    orderingConfig: {
      orderingMode: "weight",
      defaultUnit: "kg",
      allowedUnits: ["kg", "500g", "250g", "piece"],
      portionOptions: ["250 g", "500 g", "1 kg", "2 kg"],
      orderFlow: ["Items", "Weight / Piece", "Quantity", "Order"],
      unitLabel: "per kg / piece",
    },
  },
  {
    key: "fish_shop",
    label: "Fish Shop",
    icon: "🐟",
    description: "Fresh fish and seafood",
    orderingConfig: {
      orderingMode: "weight",
      defaultUnit: "kg",
      allowedUnits: ["kg", "500g", "piece"],
      portionOptions: ["500 g", "1 kg", "2 kg"],
      orderFlow: ["Items", "Weight / Piece", "Quantity", "Order"],
      unitLabel: "per kg / piece",
    },
  },
  {
    key: "vegetables_shop",
    label: "Vegetables Shop",
    icon: "🥦",
    description: "Fresh vegetables and greens",
    orderingConfig: {
      orderingMode: "weight",
      defaultUnit: "kg",
      allowedUnits: ["kg", "500g", "250g", "bunch", "piece"],
      portionOptions: ["250 g", "500 g", "1 kg"],
      orderFlow: ["Items", "Weight / Bunch", "Quantity", "Order"],
      unitLabel: "per kg / bunch",
    },
  },
  {
    key: "fruits_shop",
    label: "Fruits Shop",
    icon: "🍎",
    description: "Fresh fruits and seasonal produce",
    orderingConfig: {
      orderingMode: "weight",
      defaultUnit: "kg",
      allowedUnits: ["kg", "500g", "dozen", "piece"],
      portionOptions: ["500 g", "1 kg", "2 kg", "Dozen"],
      orderFlow: ["Items", "Weight / Dozen", "Quantity", "Order"],
      unitLabel: "per kg / dozen",
    },
  },
  {
    key: "bakery",
    label: "Bakery",
    icon: "🥐",
    description: "Breads, cakes, pastries and baked goods",
    orderingConfig: {
      orderingMode: "piece",
      defaultUnit: "piece",
      allowedUnits: ["piece", "box", "kg", "half-kg", "dozen"],
      portionOptions: ["1 Piece", "6 Pieces", "Box", "1 kg"],
      orderFlow: ["Products", "Piece / Box / kg", "Quantity", "Order"],
      unitLabel: "per piece / box",
    },
  },
  {
    key: "sweets_shop",
    label: "Sweets Shop",
    icon: "🍮",
    description: "Indian sweets, mithai and confectionery",
    orderingConfig: {
      orderingMode: "weight",
      defaultUnit: "250g",
      allowedUnits: ["250g", "500g", "kg", "piece", "box"],
      portionOptions: ["250 g", "500 g", "1 kg", "Box"],
      orderFlow: ["Products", "kg / Grams / Piece", "Quantity", "Order"],
      unitLabel: "per kg / grams",
    },
  },
  {
    key: "grocery",
    label: "Grocery Store",
    icon: "🛒",
    description: "General grocery and household essentials",
    orderingConfig: {
      orderingMode: "pack",
      defaultUnit: "pack",
      allowedUnits: ["pack", "piece", "kg", "litre", "dozen"],
      portionOptions: ["1 Pack", "1 kg", "1 Litre"],
      orderFlow: ["Products", "Pack / kg / Litre", "Quantity", "Order"],
      unitLabel: "per pack / unit",
    },
  },
  {
    key: "dairy",
    label: "Dairy Shop",
    icon: "🥛",
    description: "Milk, paneer, curd, butter and dairy products",
    orderingConfig: {
      orderingMode: "volume",
      defaultUnit: "litre",
      allowedUnits: ["litre", "500ml", "250ml", "packet", "piece", "kg"],
      portionOptions: ["250 ml", "500 ml", "1 Litre", "Packet"],
      orderFlow: ["Products", "Litre / ml / Packet", "Quantity", "Order"],
      unitLabel: "per litre / packet",
    },
  },
  {
    key: "juice_bar",
    label: "Juice Bar",
    icon: "🧃",
    description: "Fresh juices, smoothies and cold beverages",
    orderingConfig: {
      orderingMode: "volume",
      defaultUnit: "glass",
      allowedUnits: ["glass", "small", "medium", "large", "bottle"],
      portionOptions: ["Small", "Medium", "Large", "Bottle"],
      orderFlow: ["Drinks", "Size", "Quantity", "Order"],
      unitLabel: "per glass / size",
    },
  },
  {
    key: "cafe",
    label: "Cafe / Tea Shop",
    icon: "☕",
    description: "Tea, coffee, snacks and light bites",
    orderingConfig: {
      orderingMode: "piece",
      defaultUnit: "cup",
      allowedUnits: ["cup", "small", "medium", "large", "piece", "plate"],
      portionOptions: ["Small", "Regular", "Large"],
      orderFlow: ["Items", "Size / Cup", "Quantity", "Order"],
      unitLabel: "per cup / piece",
    },
  },
  {
    key: "other",
    label: "Other",
    icon: "🏪",
    description: "Other food or beverage vendor",
    orderingConfig: {
      orderingMode: "piece",
      defaultUnit: "piece",
      allowedUnits: ["piece", "kg", "litre", "pack", "box"],
      portionOptions: ["1 Unit"],
      orderFlow: ["Products", "Unit", "Quantity", "Order"],
      unitLabel: "per unit",
    },
  },
];

const { getDefaultMenuForVendorType } = require("./defaultMenusByVendorType");

const VENDOR_TYPE_KEYS = VENDOR_TYPES.map((v) => v.key);

function getVendorTypeLabel(key) {
  const found = VENDOR_TYPES.find((v) => v.key === key);
  return found ? found.label : "Vendor";
}

function getVendorTypeConfig(key) {
  const found = VENDOR_TYPES.find((v) => v.key === key);
  return found ? found.orderingConfig : VENDOR_TYPES[0].orderingConfig;
}

/** Vendor types enriched with starter category/item templates for onboarding UI. */
function getVendorTypesWithDefaultMenus() {
  return VENDOR_TYPES.map((v) => {
    const menu = getDefaultMenuForVendorType(v.key);
    return {
      ...v,
      defaultMenu: {
        categories: (menu.categories || []).map((c) => ({
          name: c.name,
          itemNames: (c.items || []).map((i) => i.name),
          items: c.items || [],
        })),
      },
    };
  });
}

module.exports = {
  VENDOR_TYPES,
  VENDOR_TYPE_KEYS,
  getVendorTypeLabel,
  getVendorTypeConfig,
  getVendorTypesWithDefaultMenus,
};
