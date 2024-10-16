
// Jito Bundling part

import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js"
import { BLOCKENGINE_URL, JITO_FEE, JITO_KEY, RPC_ENDPOINT, RPC_WEBSOCKET_ENDPOINT } from "../constants"
import base58 from "bs58" 
import { searcherClient } from 'jito-ts/dist/sdk/block-engine/searcher.js';
import { SearcherClient } from "jito-ts/dist/sdk/block-engine/searcher"
import { Bundle } from "jito-ts/dist/sdk/block-engine/types.js";
import { isError } from "jito-ts/dist/sdk/block-engine/utils"
import { logger } from "../utils";

const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
})

export async function bundle(txs: VersionedTransaction[], keypair: Keypair) {
  try {
    if (txs.length % 3 !== 0) {
      logger.warn("Transaction sequence is not a multiple of 3: Adjusting...");
      txs = txs.slice(0, Math.floor(txs.length / 3) * 3); // Trim to nearest multiple of 3
    }

    let successNum = 0;

    for (let i = 0; i < txs.length; i += 3) {
      const newTxs = txs.slice(i, i + 3); // Extract exactly three transactions (buy-sell-sell)
      const success = await bull_dozer(newTxs, keypair);

      if (success) successNum++;
    }

    return successNum === txs.length / 3;
  } catch (error) {
    logger.error("Error in bundling transactions:", error);
    return false;
  }
}

export async function bull_dozer(txs: VersionedTransaction[], keypair: Keypair) {
  const MAX_RETRIES = 3;
  let retries = 0;

  while (retries < MAX_RETRIES) {
    try {
      const search = searcherClient(BLOCKENGINE_URL);
      await build_bundle(search, 4, txs, keypair); // Fixed bundleTransactionLimit to 4
      const bundle_result = await onBundleResult(search);

      if (bundle_result) {
        logger.info("Bundle succeeded");
        return true;
      }
    } catch (error) {
      logger.warn(`Bundle failed. Retrying... (${++retries}/${MAX_RETRIES})`, error);
    }
  }

  logger.error("Exceeded maximum retries for bull_dozer");
  return false;
}

async function build_bundle(
  search: SearcherClient,
  bundleTransactionLimit: number,
  txs: VersionedTransaction[],
  keypair: Keypair
) {
  const accounts = await search.getTipAccounts();
  const _tipAccount = accounts[Math.min(Math.floor(Math.random() * accounts.length), 3)];
  const tipAccount = new PublicKey(_tipAccount);

  const bund = new Bundle([], bundleTransactionLimit);
  const resp = await solanaConnection.getLatestBlockhash("processed");
   
  bund.addTransactions(...txs);

  // Log transaction size 

  let maybeBundle = bund.addTipTx(
    keypair,
    JITO_FEE,
    tipAccount,
    resp.blockhash
  );

  if (isError(maybeBundle)) {
    logger.error("Error adding tip transaction:", maybeBundle);
    throw maybeBundle;
  }
  
  try {
    await search.sendBundle(maybeBundle);
  } catch (e) {
    logger.error("Error sending bundle:", e);
    throw e; // Rethrow the error for further handling
  }
  return maybeBundle;
}

export const onBundleResult = (c: SearcherClient): Promise<number> => {
  let first = 0
  let isResolved = false

  return new Promise((resolve) => {
    // Set a timeout to reject the promise if no bundle is accepted within 5 seconds
    setTimeout(() => {
      resolve(first)
      isResolved = true
    }, 30000)

    c.onBundleResult(
      (result: any) => {
        if (isResolved) return first
        // clearTimeout(timeout) // Clear the timeout if a bundle is accepted
        const isAccepted = result.accepted
        const isRejected = result.rejected
        if (isResolved == false) {

          if (isAccepted) { 
            first += 1
            isResolved = true
            resolve(first) // Resolve with 'first' when a bundle is accepted
          }
          if (isRejected) {
            // Do not resolve or reject the promise here
          }
        }
      },
      (e: any) => {
        // Do not reject the promise here
      }
    )
  })
}
 