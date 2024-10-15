import { Keypair, Connection, clusterApiUrl, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import { sleep } from "./utils";

const secretKey = JSON.parse(fs.readFileSync('./keypair.json', 'utf-8'));
const baseKeypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));

const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');

// Derive the wallet using the same logic as before
function deriveDeterministicWallet(baseSeed: Uint8Array, index: number): Keypair {
  const seedWithIndex = new Uint8Array([...baseSeed.slice(0, 31), index]);
  return Keypair.fromSeed(seedWithIndex);
}

// Fetch the SOL balance and token accounts of a derived wallet
async function checkWallet(index: number) {
  const derivedWallet = deriveDeterministicWallet(baseKeypair.secretKey, index);
  console.log(`Checking Wallet ${index}: ${derivedWallet.publicKey.toBase58()}`);

  // Check SOL balance
  const balance = await connection.getBalance(derivedWallet.publicKey);
  if (balance > 0){
    console.log(`  SOL Balance: ${balance / 1e9} SOL`);
    console.log(` Derived Wallet Secret  ${derivedWallet.secretKey}`);
    fs.writeFileSync(
        `./derived-wallet.json`,
        JSON.stringify(Array.from(derivedWallet.secretKey))
      );
  } 

 
}

async function main() {
  // Check all derived wallets (adjust the range as needed)
  for (let i = 0; i < 2000; i++) {
    await sleep(1000)
    await checkWallet(i);
  }
}

main().catch((error) => console.error("Error:", error));
