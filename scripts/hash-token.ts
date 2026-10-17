import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const pepper = process.env.TOKEN_PEPPER ?? "";
if (!pepper) {
  console.error("Set TOKEN_PEPPER");
  process.exit(2);
}
const token = readFileSync(0, "utf8").trim();
if (!token) {
  console.error("Pass the token on stdin");
  process.exit(2);
}
process.stdout.write(`${createHash("sha256").update(`${pepper}${token}`).digest("hex")}\n`);
