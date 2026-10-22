# ⚡ Crypto Payment Gateway (Zero-KYC, Non-Custodial)

A self-hosted, lightweight crypto payment processing backend and checkout UI for your website. 

* **Zero-KYC:** Direct wallet-to-wallet transfers. No business accounts, IDs, or third-party approvals.
* **Non-Custodial:** Funds go directly into your personal MetaMask / Trust Wallet. The server never holds private keys.
* **Low-Cost Networks:** Built-in support for **Polygon USDT** (fees < $0.005) and **BSC USDT**.
* **Deployable on Render:** Runs 100% on Render's free tier with keep-alive support.

---

## 🚀 Quick Start (Local)

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure your wallet:**
   Copy `.env.example` to `.env` and set your personal EVM wallet address:
   ```env
   MERCHANT_WALLET_ADDRESS=0xYourEVMWalletAddressHere
   PORT=3000
   ```

3. **Start the server:**
   ```bash
   npm start
   ```

4. Open `http://localhost:3000` in your browser to view the demo checkout.

---

## 📡 API Endpoints

### 1. `POST /api/invoice`
Create an invoice for an order.
* **Request:**
  ```json
  {
    "amountUSD": 15.00,
    "network": "polygon",
    "orderId": "ORDER-101"
  }
  ```
* **Response:**
  ```json
  {
    "success": true,
    "invoice": {
      "invoiceId": "e2c3b8...",
      "amountUSD": 15,
      "expectedAmount": "15.00",
      "currency": "USDT",
      "network": "polygon",
      "merchantAddress": "0x...",
      "qrCode": "data:image/png;base64,...",
      "status": "PENDING"
    },
    "checkoutUrl": "/checkout.html?id=e2c3b8..."
  }
  ```

### 2. `POST /api/verify`
Verify an on-chain transaction hash.
* **Request:**
  ```json
  {
    "invoiceId": "e2c3b8...",
    "txHash": "0xabc123..."
  }
  ```
* **Response:**
  ```json
  {
    "success": true,
    "status": "PAID",
    "explorerUrl": "https://polygonscan.com/tx/0xabc123..."
  }
  ```

### 3. `GET /health`
Keep-alive ping endpoint to prevent free cloud hosts (like Render) from sleeping. Set up a free 10-minute ping with UptimeRobot.

---

## ☁️ Deploying to Render (Free)

1. Push this repository to your GitHub.
2. In [Render.com](https://render.com), click **New +** $\rightarrow$ **Web Service**.
3. Connect your repository.
4. Set Environment Variable:
   * `MERCHANT_WALLET_ADDRESS`: Your personal MetaMask/Trust Wallet address.
5. Click **Create Web Service**!
