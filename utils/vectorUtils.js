// Vector utility functions for memory retrieval
const { encode } = require('gpt-tokenizer');
const natural = require('natural');

// Compute cosine similarity between two vectors
function cosineSimilarity(vec1, vec2) {
    // Ensure vectors are of equal length
    if (vec1.length !== vec2.length) {
        throw new Error('Vectors must be of equal length');
    }

    // Compute dot product
    const dotProduct = vec1.reduce((sum, val, idx) => sum + val * vec2[idx], 0);

    // Compute magnitudes
    const magnitude1 = Math.sqrt(vec1.reduce((sum, val) => sum + val * val, 0));
    const magnitude2 = Math.sqrt(vec2.reduce((sum, val) => sum + val * val, 0));

    // Prevent division by zero
    if (magnitude1 === 0 || magnitude2 === 0) {
        return 0;
    }

    return dotProduct / (magnitude1 * magnitude2);
}

// Preprocess and tokenize input
function preprocessInput(input) {
    // Basic preprocessing: lowercase, remove punctuation
    const cleanedInput = input.toLowerCase().replace(/[^\w\s]/g, '');
    return {
        tokens: cleanedInput.split(/\s+/),
        embedding: generateEmbedding(cleanedInput)
    };
}

// Normalize similarity scores to 0-1 range
function normalizeScore(score, minScore, maxScore) {
    if (minScore === maxScore) return 1;
    return Math.max(0, Math.min(1, (score - minScore) / (maxScore - minScore)));
}

// Pad embedding to a specific length
function padEmbedding(embedding, targetLength) {
    if (embedding.length === targetLength) return embedding;
    if (embedding.length > targetLength) return embedding.slice(0, targetLength);
    
    // Pad with zeros
    const paddedEmbedding = [...embedding];
    while (paddedEmbedding.length < targetLength) {
        paddedEmbedding.push(0);
    }
    
    return paddedEmbedding;
}

// Generate embedding (placeholder - replace with actual embedding generation)
function generateEmbedding(text) {
    // TODO: Integrate with actual embedding model (e.g., OpenAI, Hugging Face)
    return encode(text).map(token => token / 1000);
}

// Jaccard Similarity calculation
function jaccardSimilarity(tokens1, tokens2) {
    const set1 = new Set(tokens1);
    const set2 = new Set(tokens2);
    
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    
    return intersection.size / union.size;
}

// Levenshtein Distance calculation
function levenshteinDistance(str1, str2) {
    return natural.LevenshteinDistance(
        str1.toLowerCase().replace(/[^a-z0-9\s]/g, ''), 
        str2.toLowerCase().replace(/[^a-z0-9\s]/g, '')
    );
}

module.exports = {
    cosineSimilarity,
    preprocessInput,
    normalizeScore,
    padEmbedding,
    generateEmbedding,
    jaccardSimilarity,
    levenshteinDistance
};
