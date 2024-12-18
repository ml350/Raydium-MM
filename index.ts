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
  ALERT_PRICE_THRESHOLD,
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
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  TOKEN_MINT,
  USE_TELEGRAM,
} from './constants'
import { Data, editJson, readJson, saveDataToFile, sleep } from './utils'
import base58 from 'bs58'
import { getBuyTx, getBuyTxWithJupiter, getSellTx, getSellTxWithJupiter, startBlockhashUpdater } from './utils/swapOnlyAmm'
import { execute } from './executor/legacy' 
import { getPoolKeys } from './utils/getPoolInfo'
import { SWAP_ROUTING } from './constants'
import { logger } from './utils/logger'
import { createInterface } from 'readline'
import axios from 'axios'
import { err } from 'pino-std-serializers'
import { latestBlockhashData } from './utils/swapOnlyAmm';

export const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
  commitment: 'finalized'
})

interface PromptAnswers {
  runBot: boolean; 
  check?: boolean;
}

const promptUser = async (): Promise<PromptAnswers> => {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const askQuestion = (question: string): Promise<string> => {
    return new Promise(resolve => rl.question(question, resolve));
  };

  const runBotAnswer = await askQuestion('Run Raydium-MM? (yes/no): ');
  const runBot = runBotAnswer.trim().toLowerCase() === 'yes';
 
  let check: boolean = false;
  
  if (runBot) {
    console.log('Do you want to generate new wallets?');
    console.log('1: Yes');
    console.log('2: No'); 

    const generateNewWallets = await askQuestion('Enter the number of your choice: ');
    if(generateNewWallets.trim() === '1') {
      check = true; 
    }
  }

  rl.close();

  return { runBot, check };
}; 

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
  logger.info(` 
  /$$$$$$$                            /$$ /$$                                 /$$      /$$ /$$      /$$
| $$__  $$                          | $$|__/                                | $$$    /$$$| $$$    /$$$
| $$  \ $$  /$$$$$$  /$$   /$$  /$$$$$$$ /$$ /$$   /$$ /$$$$$$/$$$$         | $$$$  /$$$$| $$$$  /$$$$
| $$$$$$$/ |____  $$| $$  | $$ /$$__  $$| $$| $$  | $$| $$_  $$_  $$ /$$$$$$| $$ $$/$$ $$| $$ $$/$$ $$
| $$__  $$  /$$$$$$$| $$  | $$| $$  | $$| $$| $$  | $$| $$ \ $$ \ $$|______/| $$  $$$| $$| $$  $$$| $$
| $$  \ $$ /$$__  $$| $$  | $$| $$  | $$| $$| $$  | $$| $$ | $$ | $$        | $$\  $ | $$| $$\  $ | $$
| $$  | $$|  $$$$$$$|  $$$$$$$|  $$$$$$$| $$|  $$$$$$/| $$ | $$ | $$        | $$ \/  | $$| $$ \/  | $$
|__/  |__/ \_______/ \____  $$ \_______/|__/ \______/ |__/ |__/ |__/        |__/     |__/|__/     |__/
                     /$$  | $$                                                                        
                    |  $$$$$$/                                                                        
                     \______/                                                                                                             
  `)
  logger.info(`Volume bot is running`)
  logger.info(`Wallet address: ${mainKp.publicKey.toBase58()}`)
  logger.info(`Pool token mint: ${baseMint.toBase58()}`)
  logger.info(`Wallet SOL balance: ${solBalance.toFixed(3)}SOL`)
  logger.info(`Buy amount: ${BUY_AMOUNT}SOL`)
  logger.info(`Distribution amount: ${DISTRIBUTION_AMOUNT}SOL`)
  logger.info(`Use swap routinr: ${SWAP_ROUTING}`)
  logger.info(`Buying interval max: ${BUY_INTERVAL_MAX}ms`)
  logger.info(`Buying interval min: ${BUY_INTERVAL_MIN}ms`)
  logger.info(`Buy upper limit amount: ${BUY_UPPER_AMOUNT}SOL`)
  logger.info(`Buy lower limit amount: ${BUY_LOWER_AMOUNT}SOL`)
  logger.info(`Distribute SOL to ${distritbutionNum} wallets`)
  startBlockhashUpdater(solanaConnection);
  if(USE_TELEGRAM){
    await sendTelegramNotification(`🤖 Raydium-MM Bot started!  \n👤 Wallet: <code> ${mainKp.publicKey.toBase58()} </code>  \n💰 SOL balance: ${solBalance.toFixed(3)} SOL `);
  }
  
  if (SWAP_ROUTING) {
    logger.info("Buy and sell with jupiter swap v6 routing")
  } else {
    poolKeys = await getPoolKeys(solanaConnection, baseMint)
    if (poolKeys == null) {
      return
    }
    // poolKeys = await PoolKeys.fetchPoolKeyInfo(solanaConnection, baseMint, NATIVE_MINT)
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
       // Send Telegram notification if balance is insufficient 
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
      // buy part
      const BUY_INTERVAL = Math.round(Math.random() * (BUY_INTERVAL_MAX - BUY_INTERVAL_MIN) + BUY_INTERVAL_MIN)

      const solBalance = await solanaConnection.getBalance(kp.publicKey) / LAMPORTS_PER_SOL

      let buyAmount: number
      if (IS_RANDOM)
        buyAmount = Number((Math.random() * (BUY_UPPER_AMOUNT - BUY_LOWER_AMOUNT) + BUY_LOWER_AMOUNT).toFixed(6))
      else
        buyAmount = BUY_AMOUNT 

      if(solBalance < ALERT_PRICE_THRESHOLD && USE_TELEGRAM){ 
        await sendTelegramNotification(`⚠️ <b> WARNING </b> ⚠️ \n Wallet: <code> ${kp.publicKey} </code> \nBalance: ${solBalance.toFixed(3)} SOL\nBalance is below threshold: ${ALERT_PRICE_THRESHOLD} SOL. Please top up.`);
      }      

      if (solBalance < ADDITIONAL_FEE) {
        logger.warn("Balance is not enough: ", solBalance, "SOL")
        return
      }

      // try buying until success
      let i = 0
      while (true) {
        if (i > 10) {
          logger.error("Error in buy transaction")
          return
        }

        const result = await buy(kp, baseMint, buyAmount, poolId)
        if (result) {
          buyNum++;
          logger.info(`# of buy: ${buyNum}`)
          break
        } else {
          i++
          logger.error("Buy failed, try again") 
          await sleep(1000)
        }
      }

      await sleep(1000)

      // try selling until success
      let j = 0
      while (true) {
        if (j > 10) {
          logger.error("Error in sell transaction")
          return
        }
        const result = await sell(poolId, baseMint, kp)
        if (result) {
          sellNum++;
          logger.info(`# of sell: ${sellNum}`)
          break
        } else {
          j++
          logger.error("Sell failed, try again")
          await sleep(1000)
        }
      }
      await sleep(1000 + distritbutionNum * BUY_INTERVAL)
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
      console.log(`------------------------`)
      console.log(`Generated wallet: ${wallet.publicKey.toBase58()}`)
      console.log(`Secret Key: ${base58.encode(wallet.secretKey)}`)
      console.log(`------------------------`)
      wallets.push({ kp: wallet, buyAmount: solAmount })
      sendSolTx.push(
        SystemProgram.transfer({
          fromPubkey: mainKp.publicKey,
          toPubkey: wallet.publicKey,
          lamports: solAmount * LAMPORTS_PER_SOL
        })
      )
    }
    await sleep(3000)
    let index = 0
    while (true) {
      try {
        if (index > 3) {
          return null
        }
        const siTx = new Transaction().add(...sendSolTx) 
        siTx.feePayer = mainKp.publicKey
        siTx.recentBlockhash = latestBlockhashData?.blockhash
        const messageV0 = new TransactionMessage({
          payerKey: mainKp.publicKey,
          recentBlockhash: latestBlockhashData?.blockhash!,
          instructions: sendSolTx,
        }).compileToV0Message()
        const transaction = new VersionedTransaction(messageV0)
        transaction.sign([mainKp])
        const txSig = await execute(solanaConnection, transaction, latestBlockhashData!)
        const tokenBuyTx = txSig ? `https://solscan.io/tx/${txSig}` : ''
        console.log("SOL distributed ", tokenBuyTx)
        break
      } catch (error) { 
        logger.error("Error in distribution")
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
    })
    
    try {
      saveDataToFile(data)
    } catch (error) {
      
    } 
    return wallets
  } catch (error) {
    logger.error(`Failed to transfer SOL`)
    return null
  }
}

const buy = async (newWallet: Keypair, baseMint: PublicKey, buyAmount: number, poolId: PublicKey) => {
  let solBalance: number = 0
  try {
    solBalance = await solanaConnection.getBalance(newWallet.publicKey)
  } catch (error) {
    console.log("Error getting balance of wallet")
    return null
  }
  if (solBalance == 0) {
    return null
  }
  try {
    let tx;
    if (SWAP_ROUTING)
      tx = await getBuyTxWithJupiter(newWallet, baseMint, buyAmount)
    else
      tx = await getBuyTx(solanaConnection, newWallet, baseMint, NATIVE_MINT, buyAmount, poolId.toBase58())
    if (tx == null) {
      logger.error(`Error getting buy transaction`)
      return null
    } 
    const txSig = await execute(solanaConnection, tx, latestBlockhashData!)
    const tokenBuyTx = txSig ? `https://solscan.io/tx/${txSig}` : ''
    editJson({
      tokenBuyTx,
      pubkey: newWallet.publicKey.toBase58(),
      solBalance: solBalance / 10 ** 9 - buyAmount,
    })
    return tokenBuyTx
  } catch (error) { 
    return null
  }
}

export const sell = async (poolId: PublicKey, baseMint: PublicKey, wallet: Keypair) => {
  try {
    const data: Data[] = readJson()
    if (data.length == 0) {
      await sleep(1000)
      return null
    }

    const tokenAta = await getAssociatedTokenAddress(baseMint, wallet.publicKey)
    const tokenBalInfo = await solanaConnection.getTokenAccountBalance(tokenAta)
    if (!tokenBalInfo) {
      console.log("Balance incorrect")
      return null
    }
    const tokenBalance = tokenBalInfo.value.amount

    try {
      let sellTx;
      if (SWAP_ROUTING)
        sellTx = await getSellTxWithJupiter(wallet, baseMint, tokenBalance)
      else
        sellTx = await getSellTx(solanaConnection, wallet, baseMint, NATIVE_MINT, tokenBalance, poolId.toBase58())

      if (sellTx == null) {
        console.log(`Error getting Sell transaction`)
        return null
      }
 
      const txSellSig = await execute(solanaConnection, sellTx, latestBlockhashData!, false)
      const tokenSellTx = txSellSig ? `https://solscan.io/tx/${txSellSig}` : ''
      const solBalance = await solanaConnection.getBalance(wallet.publicKey)
      editJson({
        pubkey: wallet.publicKey.toBase58(),
        tokenSellTx,
        solBalance
      })
      return tokenSellTx
    } catch (error) { 
      return null
    }
  } catch (error) {
    return null
  }
} 

const sendTelegramNotification = async (message: string) => {
  const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await axios.post(telegramUrl, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    });
  } catch (error) {
    console.error('Error sending Telegram message:', error);
  }
};

main()