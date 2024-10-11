import {
  Keypair,
  Connection,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  PublicKey,
} from '@solana/web3.js'
import {
  PRIVATE_KEY,
  RPC_ENDPOINT,
  RPC_WEBSOCKET_ENDPOINT,
} from './constants'
import { sell } from './index'
import { Data, readJson } from './utils'
import base58 from 'bs58'
import { closeAccount, createCloseAccountInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token'

export const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
})
const mainKp = Keypair.fromSecretKey(base58.decode(PRIVATE_KEY))

const gather = async () => {
  const data: Data[] = readJson()
  if (data.length == 0) {
    console.log("No wallet to gather")
    return
  }

  for (let i = 0; i < data.length; i++) {
    try {
      const privateKey = data[i].privateKey; 
      const wallet = Keypair.fromSecretKey(base58.decode(privateKey))
      
      // Token sell logic (sell all tokens before gathering SOL)
      const tokenAccounts = await solanaConnection.getParsedTokenAccountsByOwner(
        wallet.publicKey,
        { programId: TOKEN_PROGRAM_ID }
      );
  
      //Iterate over token accounts to sell tokens
      for (let tokenAccount of tokenAccounts.value) {
        const tokenAccountPubkey = new PublicKey(tokenAccount.pubkey);
        const tokenBalInfo = await solanaConnection.getTokenAccountBalance(tokenAccountPubkey);
        const tokenBalance = tokenBalInfo?.value?.uiAmount ?? 0;
      
        if (tokenBalance > 0) {
          console.log(`Selling ${tokenBalance} tokens from ${wallet.toString()}`);
      
          const poolId = new PublicKey("2Z9SGDsHWvdKddAkfQS5QJ7ecaj18cwcHWcsDy9CrwuN"); // Update this accordingly
          const baseMint = new PublicKey(tokenAccount.account.data.parsed.info.mint);
      
          // Call the sell function for each token account
          const sellTx = await sell(poolId, baseMint, wallet);
          if (!sellTx) {
            console.log(`Failed to sell tokens from account ${tokenAccountPubkey.toBase58()}`);
            continue;
          }

          // Handle sellTx correctly if it's a string (signature) or TransactionInstruction
             if (typeof sellTx !== 'string') {
            const transaction = new Transaction().add(sellTx); // Create transaction for selling
            const latestBlockhashForSell = await solanaConnection.getLatestBlockhash();
            transaction.recentBlockhash = latestBlockhashForSell.blockhash;
            transaction.feePayer = wallet.publicKey;
            await sendAndConfirmTransaction(solanaConnection, transaction, [wallet], { skipPreflight: true });
            console.log(`Sold tokens from account ${tokenAccountPubkey.toBase58()}`);
          } 
      
          // After selling, close the token account to reclaim rent
          const closeAccountIx = createCloseAccountInstruction(  
            tokenAccountPubkey, // token account to be closed
            wallet.publicKey, // destination (where to send the reclaimed SOL)
            wallet.publicKey, // owner of the token account 
          );
          const closeTx = new Transaction().add(closeAccountIx);
          await sendAndConfirmTransaction(solanaConnection, closeTx, [wallet], { skipPreflight: true });
          console.log(`Closed token account ${tokenAccountPubkey.toBase58()}`);
        }
      }
      
      // Now, gather remaining SOL after selling tokens and closing accounts
      const balance = await solanaConnection.getBalance(wallet.publicKey)
      if (balance == 0) {
        console.log("sol balance is 0, skip this wallet")
        continue
      }
      const rent = await solanaConnection.getMinimumBalanceForRentExemption(32)
      
      const transaction = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 600_000 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 20_000 }),
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: mainKp.publicKey,
          lamports: balance - 13 * 10 ** 3 - rent
        })
      )
      
      transaction.recentBlockhash = (await solanaConnection.getLatestBlockhash()).blockhash
      transaction.feePayer = wallet.publicKey
      console.log(await solanaConnection.simulateTransaction(transaction))
      const sig = await sendAndConfirmTransaction(solanaConnection, transaction, [wallet], { skipPreflight: true })
      console.log({ sig })
      
    } catch (error) {
      console.log("Failed to gather sol in a wallet", error)
    }
  }
}

gather()
