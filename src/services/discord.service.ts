import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client, Collection, Events, GatewayIntentBits, REST, Routes, SlashCommandBuilder, TextChannel } from 'discord.js';

interface IDiscordCommand {
    data: SlashCommandBuilder;
    execute(interaction: any): Promise<void>;
}

const subscribeCommand = {
    data: new SlashCommandBuilder()
        .setName('subscribe')
        .setDescription('Subscribes you to specified address'),
    async execute(interaction) {
        await interaction.reply('Work In Progress');
    }
}

const commands = [
    subscribeCommand
]

@Injectable()
export class DiscordService implements OnModuleInit {
    private token: string;
    private clientId: string;
    private guildId: string;
    private channelId: string;

    private bot: Client;
    private commandCollection: Collection<string, IDiscordCommand>;


    constructor(private readonly configService: ConfigService) {
        this.token = this.configService.get('DISCORD_BOT_TOKEN');
        this.clientId = this.configService.get('DISCORD_BOT_CLIENTID');
        this.guildId = this.configService.get('DISCORD_BOT_GUILD_ID');
        this.channelId = this.configService.get('DISCORD_BOT_CHANNEL_ID')

        console.log('discord init')

        this.commandCollection = new Collection();
        commands.forEach(command => {
            this.commandCollection.set(command.data.name, command);
        });
        this.bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
        this.bot.login(this.token);
    }

    async onModuleInit(): Promise<void> {

        await this.registerCommands();


        this.bot.on(Events.InteractionCreate, async interaction => {
            if (!interaction.isChatInputCommand()) return;

            const command = this.commandCollection.get(interaction.commandName);

            if (!command) {
                console.error(`No command matching ${interaction.commandName} was found.`);
                return;
            }

            try {
                await command.execute(interaction);
            } catch (error) {
                console.error(error);
                if (interaction.replied || interaction.deferred) {
                    await interaction.followUp({ content: 'There was an error while executing this command!', ephemeral: true });
                } else {
                    await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
                }
            }
        });
    }

    private async registerCommands() {
        const rest = new REST().setToken(this.token);
        try {
            console.log(`Started refreshing ${commands.length} application (/) commands.`);

            // The put method is used to fully refresh all commands in the guild with the current set
            const data = await rest.put(
                Routes.applicationGuildCommands(this.clientId, this.guildId),
                { body: commands.map(c => c.data.toJSON()) },
            ) as any;

            console.log(`Successfully reloaded ${data.length} application (/) commands.`);
        } catch (error) {
            // And of course, make sure you catch and log any errors!
            console.error(error);
        }
    }

    public async notifySUbscribersBlockFound() {
        const guild = await this.bot.guilds.fetch(this.guildId);
        const channel = await guild.channels.fetch(this.channelId) as TextChannel;
        channel.send("Block Found!")
    }
}