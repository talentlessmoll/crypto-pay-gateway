import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { ethers } from "ethers";
import QRCode from "qrcode";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ==========================================
// CONFIGURATION & NETWORKS
// ==========================================
const MERCHANT_WALLET = (process.env.MERCHANT_WALLET_ADDRESS || "0x0000000000000000000000000000000000000000").toLowerCase();

const NETWORKS = {
  polygon: {
    name: "Polygon (PoS)",
    rpc: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
    usdtContract: (process.env.POLYGON_USDT_CONTRACT || "0xc2132D05D31c914a87C6611C10748AEb04B58e8F").toLowerCase(),
    decimals: 6,
    symbol: "USDT",
    minConfirmations: 3,
    explorer: "https://polygonscan.com/tx/"
  },
  bsc: {
    name: "BNB Smart Chain (BSC)",
    rpc: process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org",
    usdtContract: (process.env.BSC_USDT_CONTRACT || "0x55d398326f99059fF775485246999027B3197955").toLowerCase(),
    decimals: 18,
    symbol: "USDT",
    minConfirmations: 3,
    explorer: "https://bscscan.com/tx/"
  }
};

// In-Memory Invoice Store (Can be easily backed by SQLite/MongoDB)
const invoices = new Map();

// Helper: Get RPC Provider for network
function getProvider(networkKey) {
  const net = NETWORKS[networkKey] || NETWORKS.polygon;
  return new ethers.JsonRpcProvider(net.rpc);
}

// ==========================================
// ROUTES
// ==========================================

/**
 * 1. Health check & keep-alive for Render
 */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    merchantWallet: MERCHANT_WALLET
  });
});

/**
 * 2. Create a new crypto invoice
 */
app.post("/api/invoice", async (req, res) => {
  try {
    const { amountUSD, orderId, network = "polygon" } = req.body;

    if (!amountUSD || isNaN(amountUSD) || Number(amountUSD) <= 0) {
      return res.status(400).json({ error: "Invalid amountUSD. Must be a positive number." });
    }

    const selectedNetwork = NETWORKS[network] ? network : "polygon";
    const netConfig = NETWORKS[selectedNetwork];
    const invoiceId = uuidv4();

    // 1 USDT = 1 USD (Standard 1:1 stablecoin peg)
    const expectedCryptoAmount = Number(amountUSD).toFixed(2);

    // Generate QR Code containing merchant address
    const qrData = await QRCode.toDataURL(MERCHANT_WALLET);

    const invoice = {
      invoiceId,
      orderId: orderId || invoiceId,
      amountUSD: Number(amountUSD),
      expectedAmount: expectedCryptoAmount,
      currency: "USDT",
      network: selectedNetwork,
      networkName: netConfig.name,
      merchantAddress: MERCHANT_WALLET,
      qrCode: qrData,
      status: "PENDING", // PENDING, PAID, EXPIRED
      txHash: null,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60 * 60 * 1000 // 60 minutes
    };

    invoices.set(invoiceId, invoice);

    res.json({
      success: true,
      invoice,
      checkoutUrl: `/checkout.html?id=${invoiceId}`
    });
  } catch (err) {
    console.error("Error creating invoice:", err);
    res.status(500).json({ error: "Failed to create invoice" });
  }
});

/**
 * 3. Fetch invoice status
 */
app.get("/api/invoice/:id", (req, res) => {
  const invoice = invoices.get(req.params.id);
  if (!invoice) {
    return res.status(404).json({ error: "Invoice not found" });
  }

  // Check expiration
  if (invoice.status === "PENDING" && Date.now() > invoice.expiresAt) {
    invoice.status = "EXPIRED";
  }

  res.json({ success: true, invoice });
});

/**
 * 4. Verify payment via transaction hash
 */
app.post("/api/verify", async (req, res) => {
  try {
    const { invoiceId, txHash } = req.body;

    if (!invoiceId || !txHash) {
      return res.status(400).json({ error: "Missing invoiceId or txHash" });
    }

    const invoice = invoices.get(invoiceId);
    if (!invoice) {
      return res.status(404).json({ error: "Invoice not found" });
    }

    if (invoice.status === "PAID") {
      return res.json({ success: true, message: "Invoice is already paid", invoice });
    }

    const netConfig = NETWORKS[invoice.network];
    const provider = getProvider(invoice.network);

    // Fetch transaction receipt from blockchain RPC
    const receipt = await provider.getTransactionReceipt(txHash);

    if (!receipt) {
      return res.status(400).json({
        success: false,
        error: "Transaction not yet mined or not found on " + netConfig.name + ". Please wait a few seconds and try again."
      });
    }

    if (receipt.status !== 1) {
      return res.status(400).json({ success: false, error: "Transaction failed or reverted on chain." });
    }

    // Check block confirmations
    const currentBlock = await provider.getBlockNumber();
    const confirmations = currentBlock - receipt.blockNumber;

    if (confirmations < netConfig.minConfirmations) {
      return res.status(202).json({
        success: false,
        status: "CONFIRMING",
        confirmations,
        requiredConfirmations: netConfig.minConfirmations,
        message: `Awaiting confirmations (${confirmations}/${netConfig.minConfirmations})`
      });
    }

    // Parse ERC-20 Transfer Event: Transfer(address from, address to, uint256 value)
    const transferEventTopic = ethers.id("Transfer(address,address,uint256)");
    const matchingLog = receipt.logs.find(
      log => log.address.toLowerCase() === netConfig.usdtContract && log.topics[0] === transferEventTopic
    );

    if (!matchingLog) {
      return res.status(400).json({
        success: false,
        error: `No USDT transfer found in this transaction on ${netConfig.name}.`
      });
    }

    // Decode recipient and value
    const toAddress = ethers.stripZerosLeft(matchingLog.topics[2]).toLowerCase();
    const rawValue = BigInt(matchingLog.data);
    const paidAmount = Number(rawValue) / (10 ** netConfig.decimals);

    // Validate recipient and amount
    if (toAddress !== MERCHANT_WALLET) {
      return res.status(400).json({
        success: false,
        error: "Payment was sent to the wrong wallet address."
      });
    }

    // Allow a tiny margin of 0.01 for rounding if needed
    if (paidAmount < (invoice.amountUSD - 0.01)) {
      return res.status(400).json({
        success: false,
        error: `Insufficient payment: Received ${paidAmount} USDT, expected ${invoice.amountUSD} USDT.`
      });
    }

    // Mark invoice as PAID
    invoice.status = "PAID";
    invoice.txHash = txHash;
    invoice.paidAt = Date.now();
    invoice.paidAmount = paidAmount;

    console.log(`[PAYMENT VERIFIED] Invoice ${invoiceId} marked PAID. Amount: ${paidAmount} USDT on ${invoice.network}`);

    res.json({
      success: true,
      status: "PAID",
      invoice,
      explorerUrl: netConfig.explorer + txHash
    });
  } catch (err) {
    console.error("Payment verification error:", err);
    res.status(500).json({ error: "Verification failed: " + err.message });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`=================================================`);
  console.log(`🚀 Crypto Payment Gateway running on port ${PORT}`);
  console.log(`💰 Merchant Wallet: ${MERCHANT_WALLET}`);
  console.log(`🌐 Networks: Polygon (USDT), BSC (USDT)`);
  console.log(`=================================================`);
});
