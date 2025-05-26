const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const logger = require('../utils/logger');
const { getGameManager } = require('../utils/chess/gameManager');
const { getBoardImageUrl } = require('../utils/chess/gameManager');
const Chess = require('chess.js').Chess;

const chessCommand = new SlashCommandBuilder()
    .setName('chess')
    .setDescription('Chess commands and game management')
    .addSubcommand(sub =>
        sub.setName('challenge')
            .setDescription('Play chess with RolyBot or challenge another user')
            .addUserOption(opt => 
                opt.setName('opponent')
                   .setDescription('User to challenge')
                   .setRequired(false)
            )
            .addStringOption(option =>
                option.setName('difficulty')
                    .setDescription('AI difficulty level (only applies when playing against the bot)')
                    .setRequired(false)
                    .addChoices(
                        { name: 'Beginner', value: 'beginner' },
                        { name: 'Intermediate', value: 'intermediate' },
                        { name: 'Advanced', value: 'advanced' },
                        { name: 'Master', value: 'master' }
                    )
            )
            .addBooleanOption(option =>
                option.setName('voice-chat')
                    .setDescription('Enable voice chat for this game (only one game can have voice chat at a time)')
                    .setRequired(false)
            )
    );

module.exports = {
    name: 'chess',
    data: chessCommand,
    async execute(interaction) {
        try {
            // Get the game manager instance
            const gameManager = getGameManager();
            if (!gameManager) {
                return await interaction.reply({
                    content: 'The game manager is not ready yet. Please try again in a moment.',
                    ephemeral: true
                });
            }
            
            const opponent = interaction.options.getUser('opponent');
            const useVoiceChat = interaction.options.getBoolean('voice-chat') || false;
            const difficulty = interaction.options.getString('difficulty') || 'intermediate'; // Default to intermediate if not specified

            if (opponent) {
                logger.info(`Challenger: ${interaction.user.id}`);
                logger.info(`Challenged (raw): ${opponent.id}`);
                
                // If challenging bot, auto-accept
                if (opponent.id === interaction.client.user.id) {
                    logger.info('Bot challenged: auto-accepting');
                    if (gameManager && gameManager.handleChallenge) {
                        return await gameManager.handleChallenge(interaction.user.id, opponent.id, interaction, useVoiceChat, difficulty);
                    } else {
                        logger.error('GameManager or handleChallenge is not available');
                        return await interaction.reply({
                            content: 'The game manager is not properly initialized. Please try again.',
                            ephemeral: true
                        });
                    }
                }

                // Create challenge message
                const challengeEmbed = new EmbedBuilder()
                    .setTitle('Chess Challenge!')
                    .setDescription(`<@${interaction.user.id}> has challenged <@${opponent.id}> to a chess match!`)
                    .setColor(0x5865F2);

                await interaction.reply({ embeds: [challengeEmbed], flags: 64 });

                // Store challenge in game manager
                gameManager.storeChallenge(interaction.user.id, opponent.id);
            } else {
                logger.info(`Challenged defaulted to bot: ${interaction.client.user.id}`);
                return await gameManager.handleChallenge(interaction.user.id, interaction.client.user.id, interaction, useVoiceChat);
            }
        } catch (err) {
            logger.error('Error in chess.js execute:', err);
            throw err;
        }
    },
    async handleChessButton(interaction) {
        if (!interaction.isButton()) return false;
        const customId = interaction.customId;
        if (!customId.startsWith('chess_accept_') && !customId.startsWith('chess_decline_')) return false;

        const challengerId = customId.split('_').pop();
        const challengedUserId = interaction.user.id;
        const challenge = gameManager.getChallenge(challengedUserId);
        if (!challenge || challenge.challengerId !== challengerId) {
            await interaction.reply({ content: 'No pending challenge found for you.', flags: 64 });
            return true;
        }

        if (customId.startsWith('chess_accept_')) {
            gameManager.removeChallenge(challengedUserId);
            await startChessMatch(challengerId, challengedUserId, interaction);
        } else if (customId.startsWith('chess_decline_')) {
            gameManager.removeChallenge(challengedUserId);
            // Try to DM the challenger, otherwise reply in channel
            try {
                const challenger = await interaction.client.users.fetch(challengerId);
                await challenger.send(`Your chess challenge to <@${challengedUserId}> was declined.`);
            } catch (e) {
                // Fallback: reply in channel
                await interaction.channel.send(`<@${challengerId}>, your chess challenge was declined by <@${challengedUserId}>.`);
            }
            await interaction.reply({ content: 'Challenge declined.', flags: 64 });
        }
        return true;
    }
};