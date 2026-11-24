import { pipeline } from '@huggingface/transformers'

// Loads the local MiniLM sentence model and returns embedText(text) ->
// mean-pooled, normalised vector as a plain array.
export async function createEmbedder() {
  const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' })
  return async text => {
    const result = await embedder(text, { pooling: 'mean', normalize: true })
    return Array.from(result.data)
  }
}
