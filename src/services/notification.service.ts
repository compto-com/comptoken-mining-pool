import { Injectable, OnModuleInit } from '@nestjs/common';

import { DiscordService } from './discord.service';

@Injectable()
export class NotificationService implements OnModuleInit {
    constructor(private readonly discordService: DiscordService) {}

    async onModuleInit(): Promise<void> {
        await this.discordService.notifyRestarted();
    }

    public async notifySubscribersBlockFound(height: number, message: string) {
        await this.discordService.notifySubscribersBlockFound(height, message);
    }
}
