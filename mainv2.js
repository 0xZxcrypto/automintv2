require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const { ethers } = require('ethers');
const { randomUUID } = require('crypto');

const {
  CAPTCHA_KEY,
  TURNSTILE_SITEKEY,
  RPC,
  API_BASE,
  CLIENT_ID,
  RECIPIENT,
  RELAYER,
  TOKEN,
  MINT_COUNT = 10
} = process.env;

const delay = (ms) => new Promise(r => setTimeout(r, ms));

/* ============================================================
   LOAD PRIVATE KEYS from pk.txt
============================================================ */
const PK_LIST = fs
  .readFileSync("pk.txt", "utf8")
  .trim()
  .split("\n")
  .filter(x => x.length > 10);

/* ============================================================
   CAPTCHA SOLVER — SCTG
============================================================ */
async function solveTurnstile() {
  console.log("🔵 Requesting captcha job to SCTG...");

  const create = await axios.get(
    `https://sctg.xyz/in.php?key=${CAPTCHA_KEY}&method=turnstile&sitekey=${TURNSTILE_SITEKEY}&pageurl=https://www.b402.ai/experience-b402&json=1`
  );

  if (create.data.status !== 1) {
    console.log("❌ SCTG error:", create.data);
    return null;
  }

  const jobId = create.data.request;
  console.log("🟡 Job created, ID:", jobId);

  while (true) {
    await delay(5000);

    const res = await axios.get(
      `https://sctg.xyz/res.php?key=${CAPTCHA_KEY}&id=${jobId}&json=1`
    );

    if (res.data.status === 1) {
      console.log("🟢 Captcha solved!");
      return res.data.request;
    }

    process.stdout.write(".");
  }
}

/* ============================================================
   AUTH FUNCTIONS
============================================================ */
async function getChallenge(WALLET, ts) {
  const lid = randomUUID();

  const res = await axios.post(`${API_BASE}/auth/web3/challenge`, {
    walletType: "evm",
    walletAddress: WALLET,
    clientId: CLIENT_ID,
    lid,
    turnstileToken: ts
  });

  return { lid, challenge: res.data };
}

async function verifyChallenge(WALLET, lid, sig, ts) {
  const res = await axios.post(`${API_BASE}/auth/web3/verify`, {
    walletType: "evm",
    walletAddress: WALLET,
    clientId: CLIENT_ID,
    lid,
    signature: sig,
    turnstileToken: ts
  });

  return res.data;
}

/* ============================================================
   CHECK ALLOWANCE
============================================================ */
async function checkAllowance(wallet, WALLET) {
  const abi = ["function allowance(address owner, address spender) view returns (uint256)"];
  const token = new ethers.Contract(TOKEN, abi, wallet);
  try {
    const currentAllowance = await token.allowance(WALLET, RELAYER);
    return currentAllowance;
  } catch (err) {
    console.log("❌ Check allowance error:", err.message || err);
    return ethers.BigNumber.from(0);
  }
}

/* ============================================================
   APPROVE UNLIMITED USDT (manual gas limit)
============================================================ */
async function approveUnlimited(wallet, WALLET) {
  const currentAllowance = await checkAllowance(wallet, WALLET);
  if (currentAllowance.gt(0)) {
    console.log(`✅ Already approved, skipping approve`);
    return;
  }

  const abi = ["function approve(address spender, uint256 value)"];
  const token = new ethers.Contract(TOKEN, abi, wallet);

  console.log(`🟦 Approving unlimited for wallet ${WALLET}...`);

  try {
    const Max = ethers.constants.MaxUint256;
    const tx = await token.approve(RELAYER, Max, {
      gasLimit: 60000 // manual gas, biasanya cukup untuk USDT
    });

    console.log("🔄 Approve TX:", tx.hash);
    await tx.wait();
    console.log("🟢 Approve confirmed!");
  } catch (err) {
    console.log("❌ Approve failed:", err.message || err);
  }
}

/* ============================================================
   PERMIT BUILDER
============================================================ */
async function buildPermit(wallet, amount, relayer) {
  const provider = wallet.provider;
  const net = await provider.getNetwork();
  const now = Math.floor(Date.now() / 1000);

  const msg = {
    token: TOKEN,
    from: wallet.address,
    to: RECIPIENT,
    value: amount,
    validAfter: now - 20,
    validBefore: now + 1800,
    nonce: ethers.utils.hexlify(ethers.utils.randomBytes(32))
  };

  const domain = {
    name: "B402",
    version: "1",
    chainId: net.chainId,
    verifyingContract: relayer
  };

  const types = {
    TransferWithAuthorization: [
      { name: "token", type: "address" },
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" }
    ]
  };

  const sig = await wallet._signTypedData(domain, types, msg);
  return { authorization: msg, signature: sig };
}

/* ============================================================
   RUN FOR EACH PK
============================================================ */
async function runForWallet(pk) {
  console.log("\n============================================");
  console.log("🔵 START WALLET:", pk.slice(0, 8) + "...");
  console.log("============================================");

  const provider = new ethers.providers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(pk, provider);
  const WALLET = wallet.address;

  /* LOGIN ---------------------------------------------------*/
  const ts = await solveTurnstile();
  if (!ts) return;

  const { lid, challenge } = await getChallenge(WALLET, ts);
  const signed = await wallet.signMessage(challenge.message);
  const verify = await verifyChallenge(WALLET, lid, signed, ts);
  const jwt = verify.jwt || verify.token;

  console.log("🟩 Logged in:", WALLET);

  /* APPROVE --------------------------------------------------*/
  await approveUnlimited(wallet, WALLET);

  /* FETCH REQUIREMENTS ---------------------------------------*/
  let pay;
  try {
    await axios.post(
      `${API_BASE}/faucet/drip`,
      { recipientAddress: RECIPIENT },
      { headers: { Authorization: `Bearer ${jwt}` } }
    );
  } catch (err) {
    if (err.response?.status === 402) {
      pay = err.response.data.paymentRequirements;
      console.log("💰 Requirement:", pay.amount);
    } else {
      console.log("❌ Can't get requirement:", err.response?.data || err);
      return;
    }
  }

  /* BUILD PERMITS -------------------------------------------*/
  console.log(`🧱 Building ${MINT_COUNT} permits...`);
  const permits = [];
  for (let i = 0; i < MINT_COUNT; i++) {
    permits.push(await buildPermit(wallet, pay.amount, pay.relayerContract));
  }

  /* FIRE PERMITS --------------------------------------------*/
  console.log("🚀 Sending permits...");
  await Promise.all(
    permits.map(async (p, i) => {
      try {
        const r = await axios.post(
          `${API_BASE}/faucet/drip`,
          {
            recipientAddress: RECIPIENT,
            paymentPayload: { token: TOKEN, payload: p },
            paymentRequirements: {
              network: pay.network,
              relayerContract: pay.relayerContract
            }
          },
          { headers: { Authorization: `Bearer ${jwt}` } }
        );

        console.log(`🟢 Mint #${i + 1} OK → ${r.data.nftTransaction}`);
      } catch (e) {
        console.log(`🔴 Mint #${i + 1} FAILED`, e.response?.data || e);
      }
    })
  );
}

/* ============================================================
   MAIN LOOP (ALL PK)
============================================================ */
(async () => {
  console.log(`🚀 Running ${PK_LIST.length} wallets...\n`);

  for (const pk of PK_LIST) {
    await runForWallet(pk);
  }

  console.log("\n🎉 DONE — ALL WALLETS COMPLETE!");
})();
