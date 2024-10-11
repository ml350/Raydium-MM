import { Connection, VersionedTransaction } from "@solana/web3.js"; 

interface Blockhash {
  blockhash: string;
  lastValidBlockHeight: number;
}

export const execute = async (connection: Connection, transaction: VersionedTransaction, latestBlockhash: Blockhash, isBuy: boolean = true) => {
  const solanaConnection = connection;

  const signature = await solanaConnection.sendRawTransaction(transaction.serialize(), { skipPreflight: true })
  const confirmation = await solanaConnection.confirmTransaction(
    {
      signature,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      blockhash: latestBlockhash.blockhash,
    }
  );

  if (confirmation.value.err) {
    console.log("Confrimtaion error")
    return ""
  } else {
    if (isBuy)
      console.log(`Success in buy transaction: https://solscan.io/tx/${signature}`)
    else
      console.log(`Success in Sell transaction: https://solscan.io/tx/${signature}`)
  }
  return signature
}
