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
// CONFIGURATION & WALLETS
// ==========================================
const LTC_WALLET = process.env.LTC_WALLET_ADDRESS || "ltc1qdhylsa96p9g8rpurw8ztmaps4kgjtql2c34f4s";
const EVM_WALLET = (process.env.MERCHANT_WALLET_ADDRESS || "0x0000000000000000000000000000000000000000").toLowerCase();

const NETWORKS = {
  litecoin: {
    name: "Litecoin (LTC)",
    symbol: "LTC",
    isUTXO: true,
    explorer: "https://litecoinspace.org/tx/",
    apiUrl: "https://litecoinspace.org/api"
  },
  polygon: {
    name: "Polygon (USDT)",
    rpc: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
    usdtContract: (process.env.POLYGON_USDT_CONTRACT || "0xc2132D05D31c914a87C6611C10748AEb04B58e8F").toLowerCase(),
    decimals: 6,
    symbol: "USDT",
    minConfirmations: 3,
    explorer: "https://polygonscan.com/tx/"
  },
  bsc: {
    name: "BNB Smart Chain (USDT)",
    rpc: process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org",
    usdtContract: (process.env.BSC_USDT_CONTRACT || "0x55d398326f99059fF775485246999027B3197955").toLowerCase(),
    decimals: 18,
    symbol: "USDT",
    minConfirmations: 3,
    explorer: "https://bscscan.com/tx/"
  }
};

const invoices = new Map();

// Cached live LTC price in USD
let cachedLtcPrice = 60.0;
let lastLtcFetch = 0;

async function getLtcPriceUSD() {
  const now = Date.now();
  if (now - lastLtcFetch < 60000) return cachedLtcPrice;

  try {
    const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=LTCUSDT");
    const data = await res.json();
    if (data && data.price) {
      cachedLtcPrice = parseFloat(data.price);
      lastLtcFetch = now;
      return cachedLtcPrice;
    }
  } catch (e) {
    try {
      const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd");
      const data = await res.json();
      if (data?.litecoin?.usd) {
        cachedLtcPrice = parseFloat(data.litecoin.usd);
        lastLtcFetch = now;
        return cachedLtcPrice;
      }
    } catch (err) {
      console.warn("Could not fetch fresh LTC price, using cached:", cachedLtcPrice);
    }
  }
  return cachedLtcPrice;
}

// ==========================================
// ROUTES
// ==========================================

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    ltcWallet: LTC_WALLET,
    evmWallet: EVM_WALLET
  });
});

app.post("/api/invoice", async (req, res) => {
  try {
    const { amountUSD, orderId, network = "litecoin" } = req.body;

    if (!amountUSD || isNaN(amountUSD) || Number(amountUSD) <= 0) {
      return res.status(400).json({ error: "Invalid amountUSD. Must be a positive number." });
    }

    const selectedNetwork = NETWORKS[network] ? network : "litecoin";
    const netConfig = NETWORKS[selectedNetwork];
    const invoiceId = uuidv4();

    let merchantAddress = "";
    let expectedCryptoAmount = "";
    let currencySymbol = netConfig.symbol;
    let qrPayload = "";

    if (selectedNetwork === "litecoin") {
      merchantAddress = LTC_WALLET;
      const ltcPrice = await getLtcPriceUSD();
      expectedCryptoAmount = (Number(amountUSD) / ltcPrice).toFixed(6);
      qrPayload = `litecoin:${LTC_WALLET}?amount=${expectedCryptoAmount}`;
    } else {
      merchantAddress = EVM_WALLET;
      expectedCryptoAmount = Number(amountUSD).toFixed(2);
      qrPayload = merchantAddress;
    }

    const qrCode = await QRCode.toDataURL(qrPayload);

    const invoice = {
      invoiceId,
      orderId: orderId || invoiceId,
      amountUSD: Number(amountUSD),
      expectedAmount: expectedCryptoAmount,
      currency: currencySymbol,
      network: selectedNetwork,
      networkName: netConfig.name,
      merchantAddress,
      qrCode,
      status: "PENDING",
      txHash: null,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60 * 60 * 1000
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

app.get("/api/invoice/:id", (req, res) => {
  const invoice = invoices.get(req.params.id);
  if (!invoice) return res.status(404).json({ error: "Invoice not found" });

  if (invoice.status === "PENDING" && Date.now() > invoice.expiresAt) {
    invoice.status = "EXPIRED";
  }

  res.json({ success: true, invoice });
});

app.post("/api/verify", async (req, res) => {
  try {
    const { invoiceId, txHash } = req.body;
    if (!invoiceId || !txHash) return res.status(400).json({ error: "Missing invoiceId or txHash" });

    const invoice = invoices.get(invoiceId);
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    if (invoice.status === "PAID") {
      return res.json({ success: true, message: "Invoice is already paid", invoice });
    }

    const cleanTx = txHash.trim();

    // 1. VERIFY LITECOIN (UTXO)
    if (invoice.network === "litecoin") {
      const resp = await fetch(`https://litecoinspace.org/api/tx/${cleanTx}`);
      if (!resp.ok) {
        return res.status(400).json({
          success: false,
          error: "Transaction not found on Litecoin network. Wait a few moments after broadcasting."
        });
      }

      const txData = await resp.json();
      
      let receivedLitoshis = 0;
      for (const output of txData.vout || []) {
        if (output.scriptpubkey_address === LTC_WALLET) {
          receivedLitoshis += output.value;
        }
      }

      const receivedLTC = receivedLitoshis / 100000000;
      const expectedLTC = Number(invoice.expectedAmount);

      if (receivedLTC <= 0) {
        return res.status(400).json({
          success: false,
          error: "No output in this transaction sent funds to " + LTC_WALLET
        });
      }

      if (receivedLTC < (expectedLTC * 0.98)) {
        return res.status(400).json({
          success: false,
          error: `Insufficient payment: Received ${receivedLTC.toFixed(6)} LTC, expected ${expectedLTC.toFixed(6)} LTC`
        });
      }

      invoice.status = "PAID";
      invoice.txHash = cleanTx;
      invoice.paidAt = Date.now();
      invoice.paidAmount = receivedLTC;

      console.log(`[LTC PAYMENT CONFIRMED] Invoice ${invoiceId} paid: ${receivedLTC} LTC`);

      return res.json({
        success: true,
        status: "PAID",
        invoice,
        explorerUrl: `https://litecoinspace.org/tx/${cleanTx}`
      });
    }

    // 2. VERIFY EVM USDT
    const netConfig = NETWORKS[invoice.network];
    const provider = new ethers.JsonRpcProvider(netConfig.rpc);
    const receipt = await provider.getTransactionReceipt(cleanTx);

    if (!receipt || receipt.status !== 1) {
      return res.status(400).json({ success: false, error: "Transaction not yet mined or failed on chain." });
    }

    const transferEventTopic = ethers.id("Transfer(address,address,uint256)");
    const matchingLog = receipt.logs.find(
      log => log.address.toLowerCase() === netConfig.usdtContract && log.topics[0] === transferEventTopic
    );

    if (!matchingLog) {
      return res.status(400).json({ success: false, error: `No USDT transfer found in transaction on ${netConfig.name}` });
    }

    const toAddress = ethers.stripZerosLeft(matchingLog.topics[2]).toLowerCase();
    const rawValue = BigInt(matchingLog.data);
    const paidAmount = Number(rawValue) / (10 ** netConfig.decimals);

    if (toAddress !== EVM_WALLET) {
      return res.status(400).json({ success: false, error: "Payment was sent to the wrong wallet address." });
    }

    if (paidAmount < (invoice.amountUSD - 0.01)) {
      return res.status(400).json({ success: false, error: `Insufficient payment: Received ${paidAmount} USDT` });
    }

    invoice.status = "PAID";
    invoice.txHash = cleanTx;
    invoice.paidAt = Date.now();
    invoice.paidAmount = paidAmount;

    return res.json({
      success: true,
      status: "PAID",
      invoice,
      explorerUrl: netConfig.explorer + cleanTx
    });

  } catch (err) {
    console.error("Verification error:", err);
    res.status(500).json({ error: "Verification failed: " + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`=================================================`);
  console.log(`🚀 Crypto Payment Gateway running on port ${PORT}`);
  console.log(`🪙 Litecoin (LTC) Address: ${LTC_WALLET}`);
  console.log(`🔷 EVM (USDT) Address:     ${EVM_WALLET}`);
  console.log(`=================================================`);
});
