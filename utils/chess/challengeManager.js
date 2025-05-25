const logger = require('../logger');

/**
 * Manages chess challenges between players
 */
class ChallengeManager {
    constructor() {
        /** @type {Map<string, {challengerId: string, challengedUserId: string, timestamp: number}>} */
        this.pendingChallenges = new Map();
        this.challengeTimeout = 5 * 60 * 1000; // 5 minutes in milliseconds
        this.cleanupInterval = setInterval(() => this.cleanupExpiredChallenges(), 60 * 1000); // Check every minute
    }

    /**
     * Add a new challenge
     * @param {string} challengerId - ID of the user issuing the challenge
     * @param {string} challengedUserId - ID of the user being challenged
     * @returns {boolean} True if challenge was added, false if a challenge already exists
     */
    addChallenge(challengerId, challengedUserId) {
        // Check if there's already a pending challenge for either user
        for (const [userId, challenge] of this.pendingChallenges.entries()) {
            if (userId === challengerId || userId === challengedUserId || 
                challenge.challengerId === challengerId || challenge.challengedUserId === challengedUserId) {
                return false;
            }
        }

        this.pendingChallenges.set(challengedUserId, {
            challengerId,
            challengedUserId,
            timestamp: Date.now()
        });
        logger.info(`[ChallengeManager] Challenge created: ${challengerId} -> ${challengedUserId}`);
        return true;
    }

    /**
     * Get a challenge for a user
     * @param {string} userId - ID of the user to check for challenges
     * @returns {Object|null} Challenge object or null if none exists
     */
    getChallenge(userId) {
        return this.pendingChallenges.get(userId) || null;
    }

    /**
     * Remove a challenge
     * @param {string} userId - ID of the user whose challenge to remove
     * @returns {boolean} True if a challenge was removed, false otherwise
     */
    removeChallenge(userId) {
        const challenge = this.pendingChallenges.get(userId);
        if (challenge) {
            this.pendingChallenges.delete(userId);
            logger.info(`[ChallengeManager] Challenge removed for user: ${userId}`);
            return true;
        }
        return false;
    }

    /**
     * Get all pending challenges
     * @returns {Array<Object>} Array of all pending challenges
     */
    getAllChallenges() {
        return Array.from(this.pendingChallenges.values());
    }

    /**
     * Clean up expired challenges
     * @private
     */
    cleanupExpiredChallenges() {
        const now = Date.now();
        let expiredCount = 0;

        for (const [userId, challenge] of this.pendingChallenges.entries()) {
            if (now - challenge.timestamp > this.challengeTimeout) {
                this.pendingChallenges.delete(userId);
                expiredCount++;
            }
        }

        if (expiredCount > 0) {
            logger.info(`[ChallengeManager] Cleaned up ${expiredCount} expired challenges`);
        }
    }

    /**
     * Clean up resources
     */
    destroy() {
        clearInterval(this.cleanupInterval);
    }
}

// Export singleton instance
const challengeManager = new ChallengeManager();
module.exports = challengeManager;