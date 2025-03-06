const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json()); // parse JSON bodies

// POST endpoint at /payout
app.post("/payout", async (req, res) => {
  try {
    const { amount, account_number, bank_code, vendorName, vendorId } = req.body;
    if (!amount || !account_number || !bank_code || !vendorName || !vendorId) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }

    const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
    if (!PAYSTACK_SECRET_KEY) {
      return res.status(500).json({ success: false, error: "No Paystack key configured" });
    }

    // Example: Resolve account
    const resolveResponse = await axios.get(
      `https://api.paystack.co/bank/resolve?account_number=${account_number}&bank_code=${bank_code}`,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    // Return success for demonstration
    return res.status(200).json({
      success: true,
      data: resolveResponse.data,
    });
  } catch (error) {
    console.error("Payout error:", error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      error: error.response?.data || error.message || "Payout failed",
    });
  }
});

// Start the server on the port Railway gives us, or 3000 locally
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
