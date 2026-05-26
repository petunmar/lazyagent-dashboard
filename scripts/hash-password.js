import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const password = process.argv.slice(2).join(" ");
if (!password) {
  console.error("Usage: node scripts/hash-password.js 'your-long-dashboard-password'");
  process.exit(1);
}

const params = { N: 16384, r: 8, p: 1, keylen: 64 };
const salt = randomBytes(24);
const hash = scryptSync(password, salt, params.keylen, params);

// Format: scrypt$N$r$p$saltBase64url$hashBase64url
console.log(`scrypt$${params.N}$${params.r}$${params.p}$${salt.toString("base64url")}$${hash.toString("base64url")}`);

// Quick self-check so copy/paste mistakes in this script fail loudly.
const check = scryptSync(password, salt, params.keylen, params);
if (!timingSafeEqual(hash, check)) process.exit(2);
