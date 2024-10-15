import {
    NATIVE_MINT,
    getAssociatedTokenAddress,
} from '@solana/spl-token'
import {
    Keypair,
    Connection,
    PublicKey,
    LAMPORTS_PER_SOL,
    SystemProgram,
    VersionedTransaction,
    TransactionInstruction,
    TransactionMessage,
    ComputeBudgetProgram,
    Transaction
} from '@solana/web3.js'
import {
    ADDITIONAL_FEE,
    BUY_AMOUNT,
    BUY_INTERVAL_MAX,
    BUY_INTERVAL_MIN,
    BUY_LOWER_AMOUNT,
    BUY_UPPER_AMOUNT,
    DISTRIBUTE_WALLET_NUM,
    DISTRIBUTION_AMOUNT,
    IS_RANDOM,
    PRIVATE_KEY,
    RPC_ENDPOINT,
    RPC_WEBSOCKET_ENDPOINT,
    TOKEN_MINT,
} from './constants'
import { Data, editJson, readJson, saveDataToFile, sleep } from './utils'
import base58 from 'bs58'
import { getBuyTx, getBuyTxWithJupiter, getSellTx, getSellTxWithJupiter } from './utils/swapOnlyAmm'
import { execute } from './executor/legacy'
import { bundle } from './executor/jito'
import { getPoolKeys } from './utils/getPoolInfo'
import { SWAP_ROUTING } from './constants'
import { logger } from './utils/logger'
  
export const solanaConnection = new Connection(RPC_ENDPOINT, {
wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
})
  
export const mainKp = Keypair.fromSecretKey(base58.decode(PRIVATE_KEY))
const baseMint = new PublicKey(TOKEN_MINT)
const distritbutionNum = DISTRIBUTE_WALLET_NUM > 10 ? 10 : DISTRIBUTE_WALLET_NUM
let quoteVault: PublicKey | null = null
let vaultAmount: number = 0
let poolId: PublicKey
let poolKeys = null
let sold: number = 0
let bought: number = 0
let totalSolPut: number = 0
let changeAmount = 0
let buyNum = 0
let sellNum = 0 
  
const main = async () => { 
    const solBalance = (await solanaConnection.getBalance(mainKp.publicKey)) / LAMPORTS_PER_SOL
    logger.info(`Volume bot is running`)
    logger.info(`Wallet address: ${mainKp.publicKey.toBase58()}`)
    logger.info(`Pool token mint: ${baseMint.toBase58()}`)
    logger.info(`Wallet SOL balance: ${solBalance.toFixed(3)}SOL`)
    logger.info(`Buying interval max: ${BUY_INTERVAL_MAX}ms`)
    logger.info(`Buying interval min: ${BUY_INTERVAL_MIN}ms`)
    logger.info(`Buy upper limit amount: ${BUY_UPPER_AMOUNT}SOL`)
    logger.info(`Buy lower limit amount: ${BUY_LOWER_AMOUNT}SOL`)
    logger.info(`Distribute SOL to ${distritbutionNum} wallets`)
  
    if (SWAP_ROUTING) {
      logger.info("Buy and sell with jupiter swap v6 routing")
    } else {
      poolKeys = await getPoolKeys(solanaConnection, baseMint)
      if (poolKeys == null) {
        return
      }
      poolId = new PublicKey(poolKeys.id)
      quoteVault = new PublicKey(poolKeys.quoteVault)
      logger.info(`Successfully fetched pool info: ${poolId.toBase58()}`) 
    }
  
    let data: {
      kp: Keypair;
      buyAmount: number;
    }[] | null = null
  
    const existingData: Data[] = readJson();
    if (existingData.length == 0) {
      if (solBalance < (BUY_LOWER_AMOUNT + ADDITIONAL_FEE) * distritbutionNum) {
        logger.error("Sol balance is not enough for distribution")
      }
    
      data = await distributeSol(mainKp, distritbutionNum);
      if (data === null) {
        logger.error("Distribution failed");
        return;
      }
    } else {
      logger.info(`Importing existing wallets`);
      data = existingData.map(({ privateKey, solBalance }) => ({
        kp: Keypair.fromSecretKey(base58.decode(privateKey)),
        buyAmount: solBalance! - ADDITIONAL_FEE,
      }));
    }
  
    data.map(async ({ kp }, i) => {
      await sleep((BUY_INTERVAL_MAX + BUY_INTERVAL_MIN) * i / 2)
      while (true) {
        const BUY_INTERVAL = Math.round(Math.random() * (BUY_INTERVAL_MAX - BUY_INTERVAL_MIN) + BUY_INTERVAL_MIN)
        const solBalance = await solanaConnection.getBalance(kp.publicKey) / LAMPORTS_PER_SOL
  
        let buyAmount: number
        if (IS_RANDOM)
          buyAmount = Number((Math.random() * (BUY_UPPER_AMOUNT - BUY_LOWER_AMOUNT) + BUY_LOWER_AMOUNT).toFixed(6))
        else
          buyAmount = BUY_AMOUNT
  
        if (solBalance < ADDITIONAL_FEE) {
          logger.warn("Balance is not enough: ", solBalance, "SOL")
          return
        }
  
        // Try buying until success
        let i = 0
        while (true) {
          if (i > 10) {
            logger.error("Error in buy transaction")
            return
          }
  
          const result = await buy(kp, baseMint, buyAmount, poolId)
          if (result) {
            break
          } else {
            i++
            logger.error("Buy failed, try again") 
            await sleep(1000)
          }
        }
  
        await sleep(2000)
  
        // Try selling until success
        let j = 0
        while (true) {
          if (j > 10) {
            logger.error("Error in sell transaction")
            return
          }
          const result = await sell(poolId, baseMint, kp)
          if (result) {
            break
          } else {
            j++
            logger.error("Sell failed, try again")
            await sleep(2000)
          }
        }
        await sleep(4000 + distritbutionNum * BUY_INTERVAL)
      }
    })
}
  
const distributeSol = async (mainKp: Keypair, distritbutionNum: number) => {
    const data: Data[] = []
    const wallets = []
    try {
      const sendSolTx: TransactionInstruction[] = []
      sendSolTx.push(
        ComputeBudgetProgram.setComputeUnitLimit({units: 100_000}),
        ComputeBudgetProgram.setComputeUnitPrice({microLamports: 250_000})
      )
      for (let i = 0; i < distritbutionNum; i++) {
        let solAmount = DISTRIBUTION_AMOUNT
        if (DISTRIBUTION_AMOUNT < ADDITIONAL_FEE + BUY_UPPER_AMOUNT)
          solAmount = ADDITIONAL_FEE + BUY_UPPER_AMOUNT
  
        const wallet = Keypair.generate()
        wallets.push({ kp: wallet, buyAmount: solAmount })
        sendSolTx.push(
          SystemProgram.transfer({
            fromPubkey: mainKp.publicKey,
            toPubkey: wallet.publicKey,
            lamports: solAmount * LAMPORTS_PER_SOL
          })
        )
      }
      let index = 0
      while (true) {
        try {
          if (index > 3) {
            logger.error("Error in distribution")
            return null
          }
          const siTx = new Transaction().add(...sendSolTx)
          const latestBlockhash = await solanaConnection.getLatestBlockhash()
          siTx.feePayer = mainKp.publicKey
          siTx.recentBlockhash = latestBlockhash.blockhash
          const messageV0 = new TransactionMessage({
            payerKey: mainKp.publicKey,
            recentBlockhash: latestBlockhash.blockhash,
            instructions: sendSolTx,
          }).compileToV0Message()
          const transaction = new VersionedTransaction(messageV0)
          transaction.sign([mainKp])
          const txSig = await execute(solanaConnection, transaction, latestBlockhash)
          const tokenBuyTx = txSig ? `https://solscan.io/tx/${txSig}` : ''
          logger.info("SOL distributed ", tokenBuyTx)
          break
        } catch (error) {
          index++
        }
      }
  
      wallets.map((wallet) => {
        data.push({
          privateKey: base58.encode(wallet.kp.secretKey),
          pubkey: wallet.kp.publicKey.toBase58(),
          solBalance: wallet.buyAmount + ADDITIONAL_FEE,
          tokenBuyTx: null,
          tokenSellTx: null
        })
        
        logger.info(`Generated Wallet: ${wallet.kp.publicKey.toBase58()}`)
      })
      
      try {
        saveDataToFile(data)
      } catch (error) {
        
      }
      logger.info("Success in transferring sol")
      return wallets
    } catch (error) {
      logger.error(`Failed to transfer SOL`)
      return null
    }
}
  
const buy = async (newWallet: Keypair, baseMint: PublicKey, buyAmount: number, poolId: PublicKey) => {
    let solBalance: number = 0;
    try {
        solBalance = await solanaConnection.getBalance(newWallet.publicKey);
    } catch (error) {
        console.log("Error getting balance of wallet");
        return null;
    }
    if (solBalance == 0) {
        return null;
    }
    try {
        let tx: VersionedTransaction | null;
        if (SWAP_ROUTING)
            tx = await getBuyTxWithJupiter(newWallet, baseMint, buyAmount);
        else
            tx = await getBuyTx(solanaConnection, newWallet, baseMint, NATIVE_MINT, buyAmount, poolId.toBase58());
        
        if (tx == null) {
            logger.error(`Error getting buy transaction`);
            return null;
        }

        // Bundle the transaction before executing
        const bundleResult = await bundle([tx], mainKp);
        if (!bundleResult) {
            logger.error(`Error sending bundled buy transaction`);
            return null;
        }

        const tokenBuyTx = bundleResult ? `https://solscan.io/tx/${bundleResult}` : '';
        editJson({
            tokenBuyTx,
            pubkey: newWallet.publicKey.toBase58(),
            solBalance: solBalance / 10 ** 9 - buyAmount,
        });

        // Log the updated data
        logger.info(`Updated JSON for buy: ${JSON.stringify({ tokenBuyTx, pubkey: newWallet.publicKey.toBase58() })}`);
        
        return tokenBuyTx;
    } catch (error) {
        logger.error(`Error in buy function: ${error}`);
        return null;
    }
}
  
export const sell = async (poolId: PublicKey, baseMint: PublicKey, wallet: Keypair) => {
    try {
        const data: Data[] = readJson();
        if (data.length == 0) {
            await sleep(1000);
            return null;
        }

        const tokenAta = await getAssociatedTokenAddress(baseMint, wallet.publicKey);
        const tokenBalInfo = await solanaConnection.getTokenAccountBalance(tokenAta);
        if (!tokenBalInfo) {
            logger.error("Balance incorrect");
            return null;
        }
        const tokenBalance = tokenBalInfo.value.amount;

        try {
            let sellTx: VersionedTransaction | null;
            if (SWAP_ROUTING)
                sellTx = await getSellTxWithJupiter(wallet, baseMint, tokenBalance);
            else
                sellTx = await getSellTx(solanaConnection, wallet, baseMint, NATIVE_MINT, tokenBalance, poolId.toBase58());

            if (sellTx == null) {
                logger.error(`Error getting Sell transaction`);
                return null;
            }

            // Bundle the transaction before executing
            const bundleResult = await bundle([sellTx], wallet);
            if (!bundleResult) {
                logger.error(`Error sending bundled sell transaction`);
                return null;
            }

            const tokenSellTx = bundleResult ? `https://solscan.io/tx/${bundleResult}` : '';
            const solBalance = await solanaConnection.getBalance(wallet.publicKey);
            editJson({
                pubkey: wallet.publicKey.toBase58(),
                tokenSellTx,
                solBalance,
            });

            // Log the updated data
            logger.info(`Updated JSON for sell: ${JSON.stringify({ tokenSellTx, pubkey: wallet.publicKey.toBase58() })}`);
            
            return tokenSellTx;
        } catch (error) {
            logger.error(`Error in sell function: ${error}`);
            return null;
        }
    } catch (error) {
        logger.error(`Error in sell function: ${error}`);
        return null;
    }
}
  
main()
  