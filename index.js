// index.js
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json()); // Parse JSON bodies

// POST endpoint to handle payout in one go
app.post("/payout", async (req, res) => {
  try {
    // 1) Validate input
    const { amount, account_number, bank_code, vendorName, vendorId } = req.body;
    if (!amount || !account_number || !bank_code || !vendorName || !vendorId) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields",
      });
    }

    // 2) Load Paystack secret key from environment variable
    const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
    if (!PAYSTACK_SECRET_KEY) {
      return res.status(500).json({
        success: false,
        error: "No Paystack key configured on server",
      });
    }

    // 3) Resolve account
    const resolveRes = await axios.get(
      `https://api.paystack.co/bank/resolve?account_number=${account_number}&bank_code=${bank_code}`,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
    const resolvedAccountName = resolveRes.data?.data?.account_name;
    if (!resolvedAccountName || resolvedAccountName.toLowerCase() !== vendorName.toLowerCase()) {
      return res.status(400).json({
        success: false,
        error: "Account verification failed: name mismatch or invalid details",
      });
    }

    // 4) Create a transfer recipient
    const recipientResponse = await axios.post(
      "https://api.paystack.co/transferrecipient",
      {
        type: "nuban",
        name: vendorName,
        account_number,
        bank_code,
        currency: "NGN",
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
    const recipientCode = recipientResponse.data?.data?.recipient_code;
    if (!recipientCode) {
      return res.status(400).json({
        success: false,
        error: "Failed to create transfer recipient",
      });
    }

    // 5) Initiate the transfer (convert amount to kobo)
    const transferResponse = await axios.post(
      "https://api.paystack.co/transfer",
      {
        source: "balance",
        amount: Number(amount) * 100,
        recipient: recipientCode,
        reason: "Vendor Payout",
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    // 6) Return success
    return res.status(200).json({
      success: true,
      data: transferResponse.data?.data,
      message: "Payout successful!",
    });
  } catch (error) {
    console.error("Payout error:", error.response?.data || error.message);

    // If Paystack or any step fails, respond with error
    return res.status(500).json({
      success: false,
      error: error.response?.data?.message || error.message || "Payout failed",
    });
  }
});

// Listen on the port provided by Railway or default to 3000
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
