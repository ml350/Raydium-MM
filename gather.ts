import {
  Keypair,
  Connection,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  PublicKey,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js'
import {
  PRIVATE_KEY,
  RPC_ENDPOINT,
  RPC_WEBSOCKET_ENDPOINT,
} from './constants'
import { sell } from './index'
import { Data, readJson, sleep } from './utils'
import base58 from 'bs58'
import { closeAccount, createCloseAccountInstruction, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token'

export const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
})
const mainKp = Keypair.fromSecretKey(base58.decode(PRIVATE_KEY))

const gather = async () => {
  const data: Data[] = readJson();
  if (data.length == 0) {
    console.log("No wallet to gather");
    return;
  }

  for (let i = 0; i < data.length; i++) {
    try {
      const privateKey = data[i].privateKey; 
      const wallet = Keypair.fromSecretKey(base58.decode(privateKey));

      // 1. Ensure wallet has enough balance for future transactions (e.g., 0.01 SOL)
      const currentBalance = await solanaConnection.getBalance(wallet.publicKey);
      const minimumBalance = 0.01 * LAMPORTS_PER_SOL;

      if (currentBalance < minimumBalance) {
        const topUpAmount = minimumBalance - currentBalance;
        const topUpTransaction = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: mainKp.publicKey,
            toPubkey: wallet.publicKey,
            lamports: topUpAmount,
          })
        );

        topUpTransaction.recentBlockhash = (await solanaConnection.getLatestBlockhash()).blockhash;
        topUpTransaction.feePayer = mainKp.publicKey;
        await sendAndConfirmTransaction(solanaConnection, topUpTransaction, [mainKp], { skipPreflight: true });
        console.log(`Topped up wallet ${wallet.publicKey.toBase58()} with ${topUpAmount / LAMPORTS_PER_SOL} SOL`);
      }

      await sleep(2000)
      console.log(`Sleeping`)

      // 2. Check for SPL tokens (excluding SOL/WSOL)
      const tokenAccounts = await solanaConnection.getParsedTokenAccountsByOwner(
        wallet.publicKey,
        { programId: TOKEN_PROGRAM_ID }
      );

      for (let tokenAccount of tokenAccounts.value) {
        const tokenAccountPubkey = new PublicKey(tokenAccount.pubkey);
        const tokenBalInfo = await solanaConnection.getTokenAccountBalance(tokenAccountPubkey);
        const tokenBalance = tokenBalInfo?.value?.uiAmount ?? 0;

        if (tokenBalance > 0) {
          const tokenMint = tokenAccount.account.data.parsed.info.mint;

          // Ignore WSOL or SOL related tokens
          if (tokenMint === NATIVE_MINT.toBase58()) {
            continue; // skip SOL/WSOL
          }

          console.log(`Swapping ${tokenBalance} of SPL tokens from ${wallet.publicKey.toBase58()}`);
          
          // Swap SPL token to WSOL using `sell` function
          const poolId = new PublicKey("2Z9SGDsHWvdKddAkfQS5QJ7ecaj18cwcHWcsDy9CrwuN"); // Use appropriate pool
          const sellTx = await sell(poolId, new PublicKey(tokenMint), wallet);
          if (sellTx) {
            console.log(`Swapped tokens for SOL from wallet ${wallet.publicKey.toBase58()}`);
          }

          // Close token account after selling to reclaim rent
          const closeAccountIx = createCloseAccountInstruction(
            tokenAccountPubkey,
            wallet.publicKey,
            wallet.publicKey
          );
          const closeTx = new Transaction().add(closeAccountIx);
          await sendAndConfirmTransaction(solanaConnection, closeTx, [wallet], { skipPreflight: true });
          console.log(`Closed token account ${tokenAccountPubkey.toBase58()}`);
        }
      }

      // 3. Gather remaining SOL (after all SPL tokens sold and accounts closed)
      const balanceAfterSwaps = await solanaConnection.getBalance(wallet.publicKey);
      const rentExempt = await solanaConnection.getMinimumBalanceForRentExemption(0);
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: mainKp.publicKey,
          lamports: balanceAfterSwaps - rentExempt - 5000, // Leave rent-exempt minimum
        })
      );
      transaction.recentBlockhash = (await solanaConnection.getLatestBlockhash()).blockhash;
      transaction.feePayer = wallet.publicKey;
      
      await sendAndConfirmTransaction(solanaConnection, transaction, [wallet], { skipPreflight: true });
      console.log(`Transferred SOL from wallet ${wallet.publicKey.toBase58()} to main wallet`);

    } catch (error) {
      console.log("Failed to gather SOL in a wallet", error);
    }
  }
}
gather()
