const express = require("express");
const auth = require("../../middlewares/auth");

const router = express.Router();

router.post("/assistant/chat", auth(false), (req, res) => {
  const prompt = String(req.body.prompt || "").toLowerCase();
  let reply = "Try our top-rated combo meal and add a fresh juice.";
  if (prompt.includes("spicy")) reply = "You may like peri-peri fries, spicy wraps, and hot wings.";
  if (prompt.includes("vegan")) reply = "Recommended vegan picks: hummus bowl, falafel wrap, and salad combo.";
  if (prompt.includes("analytics"))
    reply = "Insight: dinner orders peak between 7 PM and 9 PM. Consider surge staffing.";
  return res.json({ reply, suggestions: ["People also ordered garlic bread", "Try adding dessert"] });
});

module.exports = router;
