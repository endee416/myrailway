const express = require("express");
const axios = require("axios");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

// Initialize Firebase Admin using the service account JSON stored in one environment variable
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

// Middleware to verify Firebase ID token from the Authorization header
const verifyFirebaseToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ success: false, error: "Unauthorized: No token provided" });
  }
  const idToken = authHeader.split("Bearer ")[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken; // Attach decoded token (which includes uid) to the request
    next();
  } catch (error) {
    console.error("Token verification failed:", error);
    return res
      .status(401)
      .json({ success: false, error: "Unauthorized: Token verification failed" });
  }
};

// Payout endpoint, now protected by the verifyFirebaseToken middleware
app.post("/payout", verifyFirebaseToken, async (req, res) => {
  // The verified vendor's UID is available as req.user.uid
  const vendorId = req.user.uid;

  try {
    // Validate required input fields
    const { amount, account_number, bank_code, vendorName } = req.body;
    if (!amount || !account_number || !bank_code || !vendorName) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields",
      });
    }

    // Load Paystack secret key from environment variables
    const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
    if (!PAYSTACK_SECRET_KEY) {
      return res.status(500).json({
        success: false,
        error: "No Paystack key configured on server",
      });
    }

    // Resolve the account using Paystack's API
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
    if (!resolvedAccountName) {
      return res.status(400).json({
        success: false,
        error: "Account verification failed: Paystack returned no name",
      });
    }

    // Partial name match: ensure each word in vendorName exists in the resolved account name
    const resolvedLower = resolvedAccountName.toLowerCase();
    const userLower = vendorName.toLowerCase();
    const userWords = userLower.split(" ").filter(Boolean);
    let mismatch = false;
    for (const word of userWords) {
      if (!resolvedLower.includes(word)) {
        mismatch = true;
        break;
      }
    }
    if (mismatch) {
      return res.status(400).json({
        success: false,
        error: "Account verification failed: name mismatch or invalid details",
      });
    }

    // Create a transfer recipient on Paystack
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

    // Initiate the transfer on Paystack
    const transferResponse = await axios.post(
      "https://api.paystack.co/transfer",
      {
        source: "balance",
        amount: Number(amount) * 100, // convert amount from NGN to kobo
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

    return res.status(200).json({
      success: true,
      data: transferResponse.data?.data,
      message: "Payout successful!",
    });
  } catch (error) {
    console.error("Payout error:", error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      error:
        error.response?.data?.message ||
        error.message ||
        "Payout failed",
    });
  }
});

// Listen on the port provided by Railway or default to 3000
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
