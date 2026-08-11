/**
 * Starter categories + sample item names for each vendor business type.
 * Seeded into a restaurant on create / via "Apply starter menu".
 * Owners can rename, edit prices, add, or delete freely afterwards.
 *
 * Shape:
 *   { categories: [ { name, items: [ { name, price, isVeg, description? } ] } ] }
 */

const DEFAULT_MENUS_BY_VENDOR_TYPE = {
  restaurant: {
    categories: [
      {
        name: "Starters",
        items: [
          { name: "Veg Manchurian", price: 149, isVeg: true },
          { name: "Chicken 65", price: 199, isVeg: false },
          { name: "Paneer Tikka", price: 189, isVeg: true },
          { name: "Gobi 65", price: 139, isVeg: true },
        ],
      },
      {
        name: "Main Course",
        items: [
          { name: "Butter Chicken", price: 279, isVeg: false },
          { name: "Paneer Butter Masala", price: 249, isVeg: true },
          { name: "Dal Tadka", price: 149, isVeg: true },
          { name: "Chicken Biryani", price: 229, isVeg: false },
          { name: "Veg Biryani", price: 179, isVeg: true },
        ],
      },
      {
        name: "Breads & Rice",
        items: [
          { name: "Butter Naan", price: 49, isVeg: true },
          { name: "Roti", price: 25, isVeg: true },
          { name: "Jeera Rice", price: 99, isVeg: true },
          { name: "Plain Rice", price: 69, isVeg: true },
        ],
      },
      {
        name: "Beverages",
        items: [
          { name: "Masala Tea", price: 30, isVeg: true },
          { name: "Fresh Lime Soda", price: 49, isVeg: true },
          { name: "Soft Drink", price: 40, isVeg: true },
        ],
      },
      {
        name: "Desserts",
        items: [
          { name: "Gulab Jamun", price: 59, isVeg: true },
          { name: "Ice Cream", price: 79, isVeg: true },
        ],
      },
    ],
  },

  chicken_shop: {
    categories: [
      {
        name: "Fresh Chicken",
        items: [
          { name: "Chicken Whole", price: 220, isVeg: false, unit: "kg" },
          { name: "Chicken Curry Cut", price: 230, isVeg: false, unit: "kg" },
          { name: "Chicken Breast Boneless", price: 320, isVeg: false, unit: "kg" },
          { name: "Chicken Legs", price: 280, isVeg: false, unit: "kg" },
          { name: "Chicken Wings", price: 260, isVeg: false, unit: "kg" },
        ],
      },
      {
        name: "Specialty Cuts",
        items: [
          { name: "Chicken Mince (Keema)", price: 300, isVeg: false, unit: "kg" },
          { name: "Chicken Liver", price: 180, isVeg: false, unit: "kg" },
          { name: "Chicken Gizzard", price: 160, isVeg: false, unit: "kg" },
        ],
      },
      {
        name: "Marinated",
        items: [
          { name: "Tandoori Marinated Chicken", price: 280, isVeg: false, unit: "kg" },
          { name: "Biryani Cut Marinated", price: 250, isVeg: false, unit: "kg" },
        ],
      },
    ],
  },

  mutton_shop: {
    categories: [
      {
        name: "Fresh Mutton",
        items: [
          { name: "Mutton Curry Cut", price: 750, isVeg: false, unit: "kg" },
          { name: "Mutton Boneless", price: 900, isVeg: false, unit: "kg" },
          { name: "Mutton Chops", price: 850, isVeg: false, unit: "kg" },
          { name: "Mutton Leg", price: 780, isVeg: false, unit: "kg" },
        ],
      },
      {
        name: "Specialty",
        items: [
          { name: "Mutton Keema", price: 820, isVeg: false, unit: "kg" },
          { name: "Mutton Liver", price: 400, isVeg: false, unit: "kg" },
          { name: "Mutton Paya", price: 350, isVeg: false, unit: "piece" },
        ],
      },
    ],
  },

  fish_shop: {
    categories: [
      {
        name: "Fresh Fish",
        items: [
          { name: "Rohu", price: 280, isVeg: false, unit: "kg" },
          { name: "Katla", price: 300, isVeg: false, unit: "kg" },
          { name: "Pomfret", price: 650, isVeg: false, unit: "kg" },
          { name: "Seer Fish (Surmai)", price: 700, isVeg: false, unit: "kg" },
          { name: "Bangda (Mackerel)", price: 220, isVeg: false, unit: "kg" },
        ],
      },
      {
        name: "Seafood",
        items: [
          { name: "Prawns", price: 550, isVeg: false, unit: "kg" },
          { name: "Crab", price: 400, isVeg: false, unit: "kg" },
          { name: "Squid", price: 380, isVeg: false, unit: "kg" },
        ],
      },
      {
        name: "Cut & Clean",
        items: [
          { name: "Fish Curry Cut", price: 320, isVeg: false, unit: "kg" },
          { name: "Fish Fillet", price: 450, isVeg: false, unit: "kg" },
        ],
      },
    ],
  },

  vegetables_shop: {
    categories: [
      {
        name: "Leafy Greens",
        items: [
          { name: "Spinach (Palak)", price: 30, isVeg: true, unit: "bunch" },
          { name: "Coriander", price: 15, isVeg: true, unit: "bunch" },
          { name: "Methi", price: 25, isVeg: true, unit: "bunch" },
          { name: "Mint (Pudina)", price: 15, isVeg: true, unit: "bunch" },
        ],
      },
      {
        name: "Everyday Vegetables",
        items: [
          { name: "Tomato", price: 40, isVeg: true, unit: "kg" },
          { name: "Onion", price: 35, isVeg: true, unit: "kg" },
          { name: "Potato", price: 30, isVeg: true, unit: "kg" },
          { name: "Green Chilli", price: 60, isVeg: true, unit: "kg" },
          { name: "Capsicum", price: 70, isVeg: true, unit: "kg" },
          { name: "Carrot", price: 50, isVeg: true, unit: "kg" },
          { name: "Cabbage", price: 35, isVeg: true, unit: "kg" },
          { name: "Cauliflower", price: 40, isVeg: true, unit: "piece" },
        ],
      },
      {
        name: "Beans & Others",
        items: [
          { name: "Green Beans", price: 60, isVeg: true, unit: "kg" },
          { name: "Brinjal", price: 45, isVeg: true, unit: "kg" },
          { name: "Okra (Bhindi)", price: 55, isVeg: true, unit: "kg" },
          { name: "Bottle Gourd", price: 35, isVeg: true, unit: "kg" },
        ],
      },
    ],
  },

  fruits_shop: {
    categories: [
      {
        name: "Seasonal Fruits",
        items: [
          { name: "Banana", price: 50, isVeg: true, unit: "dozen" },
          { name: "Apple", price: 180, isVeg: true, unit: "kg" },
          { name: "Orange", price: 80, isVeg: true, unit: "kg" },
          { name: "Mango", price: 120, isVeg: true, unit: "kg" },
          { name: "Grapes", price: 100, isVeg: true, unit: "kg" },
        ],
      },
      {
        name: "Everyday Fruits",
        items: [
          { name: "Papaya", price: 40, isVeg: true, unit: "kg" },
          { name: "Watermelon", price: 25, isVeg: true, unit: "kg" },
          { name: "Pomegranate", price: 160, isVeg: true, unit: "kg" },
          { name: "Guava", price: 60, isVeg: true, unit: "kg" },
          { name: "Mosambi", price: 70, isVeg: true, unit: "kg" },
        ],
      },
    ],
  },

  bakery: {
    categories: [
      {
        name: "Breads",
        items: [
          { name: "White Bread", price: 40, isVeg: true },
          { name: "Brown Bread", price: 50, isVeg: true },
          { name: "Pav Bun", price: 30, isVeg: true },
          { name: "Burger Bun", price: 35, isVeg: true },
        ],
      },
      {
        name: "Cakes",
        items: [
          { name: "Chocolate Cake Slice", price: 80, isVeg: true },
          { name: "Black Forest Cake (500g)", price: 350, isVeg: true },
          { name: "Butterscotch Cake (500g)", price: 320, isVeg: true },
        ],
      },
      {
        name: "Pastries & Snacks",
        items: [
          { name: "Veg Puff", price: 25, isVeg: true },
          { name: "Egg Puff", price: 30, isVeg: false },
          { name: "Croissant", price: 45, isVeg: true },
          { name: "Cookies (Pack)", price: 60, isVeg: true },
        ],
      },
    ],
  },

  sweets_shop: {
    categories: [
      {
        name: "Milk Sweets",
        items: [
          { name: "Gulab Jamun", price: 320, isVeg: true, unit: "kg" },
          { name: "Rasgulla", price: 280, isVeg: true, unit: "kg" },
          { name: "Kalakand", price: 400, isVeg: true, unit: "kg" },
          { name: "Milk Cake", price: 380, isVeg: true, unit: "kg" },
        ],
      },
      {
        name: "Traditional",
        items: [
          { name: "Laddu", price: 300, isVeg: true, unit: "kg" },
          { name: "Jalebi", price: 250, isVeg: true, unit: "kg" },
          { name: "Mysore Pak", price: 450, isVeg: true, unit: "kg" },
          { name: "Barfi", price: 420, isVeg: true, unit: "kg" },
        ],
      },
      {
        name: "Special Boxes",
        items: [
          { name: "Assorted Sweets Box (500g)", price: 280, isVeg: true },
          { name: "Assorted Sweets Box (1kg)", price: 520, isVeg: true },
        ],
      },
    ],
  },

  grocery: {
    categories: [
      {
        name: "Staples",
        items: [
          { name: "Rice (1 kg)", price: 60, isVeg: true },
          { name: "Toor Dal (1 kg)", price: 140, isVeg: true },
          { name: "Wheat Flour (1 kg)", price: 50, isVeg: true },
          { name: "Sugar (1 kg)", price: 45, isVeg: true },
          { name: "Salt (1 kg)", price: 25, isVeg: true },
        ],
      },
      {
        name: "Oils & Spices",
        items: [
          { name: "Sunflower Oil (1 L)", price: 140, isVeg: true },
          { name: "Turmeric Powder (100g)", price: 35, isVeg: true },
          { name: "Chilli Powder (100g)", price: 40, isVeg: true },
          { name: "Garam Masala (50g)", price: 45, isVeg: true },
        ],
      },
      {
        name: "Daily Essentials",
        items: [
          { name: "Tea Powder (250g)", price: 90, isVeg: true },
          { name: "Biscuits Pack", price: 30, isVeg: true },
          { name: "Soap", price: 35, isVeg: true },
        ],
      },
    ],
  },

  dairy: {
    categories: [
      {
        name: "Milk",
        items: [
          { name: "Fresh Milk (1 L)", price: 56, isVeg: true },
          { name: "Toned Milk (500 ml)", price: 28, isVeg: true },
          { name: "Full Cream Milk (1 L)", price: 65, isVeg: true },
        ],
      },
      {
        name: "Curd & Paneer",
        items: [
          { name: "Curd (500 g)", price: 35, isVeg: true },
          { name: "Paneer (200 g)", price: 80, isVeg: true },
          { name: "Paneer (500 g)", price: 180, isVeg: true },
        ],
      },
      {
        name: "Butter & Ghee",
        items: [
          { name: "Butter (100 g)", price: 55, isVeg: true },
          { name: "Ghee (500 ml)", price: 320, isVeg: true },
          { name: "Cheese Slice Pack", price: 90, isVeg: true },
        ],
      },
    ],
  },

  juice_bar: {
    categories: [
      {
        name: "Fresh Juices",
        items: [
          { name: "Orange Juice", price: 80, isVeg: true },
          { name: "Mosambi Juice", price: 70, isVeg: true },
          { name: "Watermelon Juice", price: 60, isVeg: true },
          { name: "Pineapple Juice", price: 90, isVeg: true },
          { name: "Pomegranate Juice", price: 120, isVeg: true },
        ],
      },
      {
        name: "Shakes & Smoothies",
        items: [
          { name: "Banana Shake", price: 80, isVeg: true },
          { name: "Mango Shake", price: 100, isVeg: true },
          { name: "Chocolate Shake", price: 110, isVeg: true },
          { name: "Mixed Fruit Smoothie", price: 130, isVeg: true },
        ],
      },
      {
        name: "Specials",
        items: [
          { name: "Sugarcane Juice", price: 40, isVeg: true },
          { name: "Lemon Mint Cooler", price: 50, isVeg: true },
        ],
      },
    ],
  },

  cafe: {
    categories: [
      {
        name: "Hot Beverages",
        items: [
          { name: "Masala Chai", price: 25, isVeg: true },
          { name: "Filter Coffee", price: 40, isVeg: true },
          { name: "Cappuccino", price: 90, isVeg: true },
          { name: "Hot Chocolate", price: 100, isVeg: true },
        ],
      },
      {
        name: "Cold Beverages",
        items: [
          { name: "Cold Coffee", price: 110, isVeg: true },
          { name: "Iced Tea", price: 80, isVeg: true },
          { name: "Lemon Tea", price: 50, isVeg: true },
        ],
      },
      {
        name: "Snacks",
        items: [
          { name: "Samosa", price: 25, isVeg: true },
          { name: "Veg Sandwich", price: 70, isVeg: true },
          { name: "Paneer Sandwich", price: 90, isVeg: true },
          { name: "French Fries", price: 80, isVeg: true },
        ],
      },
    ],
  },

  other: {
    categories: [
      {
        name: "Popular Items",
        items: [
          { name: "Item 1", price: 50, isVeg: true, description: "Rename this item" },
          { name: "Item 2", price: 80, isVeg: true, description: "Rename this item" },
          { name: "Item 3", price: 100, isVeg: true, description: "Rename this item" },
        ],
      },
      {
        name: "Specials",
        items: [
          { name: "Special Item", price: 120, isVeg: true, description: "Rename this item" },
        ],
      },
    ],
  },
};

function getDefaultMenuForVendorType(businessType) {
  const key = String(businessType || "restaurant").trim();
  return DEFAULT_MENUS_BY_VENDOR_TYPE[key] || DEFAULT_MENUS_BY_VENDOR_TYPE.other;
}

function listDefaultMenuSummaries() {
  return Object.entries(DEFAULT_MENUS_BY_VENDOR_TYPE).map(([key, menu]) => ({
    businessType: key,
    categoryCount: menu.categories.length,
    itemCount: menu.categories.reduce((n, c) => n + (c.items?.length || 0), 0),
    categories: menu.categories.map((c) => ({
      name: c.name,
      items: (c.items || []).map((i) => i.name),
    })),
  }));
}

module.exports = {
  DEFAULT_MENUS_BY_VENDOR_TYPE,
  getDefaultMenuForVendorType,
  listDefaultMenuSummaries,
};
