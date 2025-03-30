const express = require("express");
const axios = require("axios");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

// Initialize Firebase Admin using the service account JSON stored in a single environment variable
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const firestore = admin.firestore();

// Middleware to verify Firebase ID token from the Authorization header
const verifyFirebaseToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    console.error("No token provided in header.");
    return res
      .status(401)
      .json({ success: false, error: "Unauthorized: No token provided" });
  }
  const idToken = authHeader.split("Bearer ")[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    console.log("Token verified. UID:", decodedToken.uid);
    req.user = decodedToken; // Attach decoded token (which includes uid) to the request
    next();
  } catch (error) {
    console.error("Token verification failed:", error);
    return res
      .status(401)
      .json({ success: false, error: "Unauthorized: Token verification failed" });
  }
};

// Payout endpoint, protected by the verifyFirebaseToken middleware
app.post("/payout", verifyFirebaseToken, async (req, res) => {
  // The verified vendor's UID is available as req.user.uid
  const vendorId = req.user.uid;
  console.log(`Payout request received from vendorId: ${vendorId}`);

  try {
    // Validate required input fields
    const { amount, account_number, bank_code, vendorName } = req.body;
    if (!amount || !account_number || !bank_code || !vendorName) {
      console.error("Missing required fields in request body:", req.body);
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }
    console.log("Request body validated:", { amount, account_number, bank_code, vendorName });

    // Load Paystack secret key from environment variables
    const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
    if (!PAYSTACK_SECRET_KEY) {
      console.error("Paystack key is not configured on the server.");
      return res.status(500).json({ success: false, error: "No Paystack key configured on server" });
    }

    // --- Check and update user's balance in Firestore ---
    console.log("Querying Firestore for user with uid:", vendorId);
    const usersQuerySnapshot = await firestore
      .collection("users")
      .where("uid", "==", vendorId)
      .limit(1)
      .get();
    if (usersQuerySnapshot.empty) {
      console.error("User not found in Firestore for vendorId:", vendorId);
      return res.status(400).json({ success: false, error: "User not found" });
    }
    const userDoc = usersQuerySnapshot.docs[0];
    const userRef = userDoc.ref;
    console.log("User document found. Document ID:", userDoc.id);

    let currentBalance;
    try {
      await firestore.runTransaction(async (transaction) => {
        const userDocSnapshot = await transaction.get(userRef);
        if (!userDocSnapshot.exists) {
          throw new Error("User not found during transaction");
        }
        currentBalance = Number(userDocSnapshot.data().balance);
        const withdrawalAmount = Number(amount);
        console.log(`Current balance: ${currentBalance}, requested withdrawal: ${withdrawalAmount}`);
        if (currentBalance < withdrawalAmount) {
          throw new Error("Insufficient balance");
        }
        // Deduct the withdrawal amount (reserve funds)
        transaction.update(userRef, { balance: currentBalance - withdrawalAmount });
        console.log(`Reserved ${withdrawalAmount} from user balance.`);
      });
    } catch (balanceError) {
      console.error("Error during balance transaction:", balanceError);
      return res.status(400).json({ success: false, error: balanceError.message });
    }
    // -----------------------------------------------------------

    // Resolve the account using Paystack's API
    console.log(`Resolving account number ${account_number} with bank code ${bank_code}`);
    let resolvedAccountName;
    try {
      const resolveRes = await axios.get(
        `https://api.paystack.co/bank/resolve?account_number=${account_number}&bank_code=${bank_code}`,
        {
          headers: {
            Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );
      resolvedAccountName = resolveRes.data?.data?.account_name;
      console.log("Resolved account name from Paystack:", resolvedAccountName);
    } catch (resolveError) {
      console.error("Account resolution error from Paystack:", resolveError.response?.data || resolveError.message);
      // Refund the reserved funds if account resolution fails
      try {
        await userRef.update({ balance: admin.firestore.FieldValue.increment(Number(amount)) });
        console.log("Refunded funds due to account resolution error.");
      } catch (refundError) {
        console.error("Refund update failed after account resolution error:", refundError);
      }
      return res.status(400).json({
        success: false,
        error: resolveError.response?.data?.message || "Could not resolve account name. Check parameters or try again.",
      });
    }
    if (!resolvedAccountName) {
      console.error("Account resolution failed: No account name returned.");
      try {
        await userRef.update({ balance: admin.firestore.FieldValue.increment(Number(amount)) });
        console.log("Refunded funds due to no account name returned.");
      } catch (refundError) {
        console.error("Refund update failed after no account name returned:", refundError);
      }
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
      console.error("Name mismatch: vendorName does not match resolved account name.");
      try {
        await userRef.update({ balance: admin.firestore.FieldValue.increment(Number(amount)) });
        console.log("Refunded funds due to name mismatch.");
      } catch (refundError) {
        console.error("Refund update failed after name mismatch:", refundError);
      }
      return res.status(400).json({
        success: false,
        error: "Account verification failed: name mismatch or invalid details",
      });
    }

    // Create a transfer recipient on Paystack
    console.log("Creating transfer recipient on Paystack for vendor:", vendorName);
    let recipientCode;
    try {
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
      recipientCode = recipientResponse.data?.data?.recipient_code;
      console.log("Recipient code from Paystack:", recipientCode);
    } catch (recipientError) {
      console.error("Error creating transfer recipient:", recipientError.response?.data || recipientError.message);
      try {
        await userRef.update({ balance: admin.firestore.FieldValue.increment(Number(amount)) });
        console.log("Refunded funds due to transfer recipient creation error.");
      } catch (refundError) {
        console.error("Refund update failed after transfer recipient creation error:", refundError);
      }
      return res.status(400).json({
        success: false,
        error: recipientError.response?.data?.message || "Failed to create transfer recipient",
      });
    }
    if (!recipientCode) {
      console.error("Failed to create transfer recipient: No recipient code returned.");
      try {
        await userRef.update({ balance: admin.firestore.FieldValue.increment(Number(amount)) });
        console.log("Refunded funds due to missing recipient code.");
      } catch (refundError) {
        console.error("Refund update failed after missing recipient code:", refundError);
      }
      return res.status(400).json({
        success: false,
        error: "Failed to create transfer recipient",
      });
    }

    // Initiate the transfer on Paystack
    let transferData;
    console.log("Initiating transfer on Paystack.");
    try {
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
      transferData = transferResponse.data?.data;
      console.log("Transfer initiated successfully:", transferData);
    } catch (transferError) {
      console.error("Transfer initiation failed:", transferError.response?.data || transferError.message);
      try {
        await userRef.update({ balance: admin.firestore.FieldValue.increment(Number(amount)) });
        console.log("Refunded funds due to transfer failure.");
      } catch (refundError) {
        console.error("Refund update failed after transfer failure:", refundError);
      }
      return res.status(500).json({
        success: false,
        error: transferError.response?.data?.message || transferError.message || "Payout failed",
      });
    }

    // On successful transfer, add the withdrawal record to Firestore
    await firestore.collection("withdrawals").add({
      uid: vendorId,
      amount: Number(amount),
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.status(200).json({
      success: true,
      data: transferData,
      message: "Payout successful!",
    });
  } catch (error) {
    console.error("Unhandled payout error:", error.response?.data || error.message);
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
