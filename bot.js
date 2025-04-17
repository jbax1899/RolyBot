require('dotenv').config();

// https://discord.js.org/#/docs/main/stable/general/welcome
const { Client, RichEmbed } = require('discord.js');
const client = new Client();

const COMMAND_PREFIX = '!rb';

client.on('ready', () => {
  console.log('I am ready!');
});

client.on('message', message => {
    if (message.content === `${COMMAND_PREFIX} help`) {
        const embed = new RichEmbed()
            .setTitle('===Help Page===')
            .setColor(0xFF0000)
            .setDescription('Currently supported commands: \n' +
                `${COMMAND_PREFIX} help \n` +
                `${COMMAND_PREFIX} ping \n` +
                `${COMMAND_PREFIX} roll \n` +
                `${COMMAND_PREFIX} rolybot \n` + 
                `${COMMAND_PREFIX} nc \n`);
        message.channel.send(embed);
    }
    else if (message.content === `${COMMAND_PREFIX} ping`) {
        message.channel.send('pong!');
    }
    else if (message.content === `${COMMAND_PREFIX} roll`) {
        var min = 1;
        var max = 100;
        var random = Math.floor(Math.random() * (+max - +min)) + +min;
        const embed = new RichEmbed()
            .setTitle(message.author.username + ' rolled a ' + random + '!')
            .setColor(0xFF0000)
        message.channel.send(embed);
    }
    else if (message.content === `${COMMAND_PREFIX} rolybot`) {
        const embed = new RichEmbed()
            .setTitle('===' + message.author.username + '===')
            .setColor(0xFF0000)
            .setDescription('Hello there!')
            .setThumbnail(message.author.displayAvatarURL)
        message.channel.send(embed);
    }
    else if (message.content === `${COMMAND_PREFIX} nc`) {
        //"No Context" random quote
        const currentChannel = message.channel;
    
        currentChannel.fetchMessages({ limit: 100 }).then(messages => {
            const randomMessage = messages.random();  // fetch a random message
    
            if (randomMessage) {
                // send an embed with the random message
                const embed = new RichEmbed()
                    .setTitle(`${randomMessage.author.username}'s Message`)
                    .setColor(0xFF0000)
                    .setThumbnail(randomMessage.author.displayAvatarURL)
                    .setDescription(randomMessage.content);
    
                message.channel.send(embed); 
            } else {
                message.channel.send('No messages found to display.');
            }
        }).catch(err => {
            console.log('Error while finding random message');
            console.log(err);
            message.channel.send('Failed to fetch messages.');
        });
    }
});

// Bot login
// Find your token at https://discordapp.com/developers/applications/me
// WARNING: Do not commit your token to git! Use an environment variable instead!
client.login(process.env.DISCORD_BOT_TOKEN);