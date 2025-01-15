import { Injectable, OnModuleInit } from '@nestjs/common';
import { Server, Socket } from 'net';

import { StratumV1Client } from '../models/StratumV1Client';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../ORM/client/client.service';
import { StratumV1JobsService } from './stratum-v1-jobs.service';


@Injectable()
export class StratumV1Service implements OnModuleInit {

  constructor(
    private readonly clientService: ClientService,
    private readonly clientStatisticsService: ClientStatisticsService,
    private readonly stratumV1JobsService: StratumV1JobsService,
  ) {

  }

  async onModuleInit(): Promise<void> {

      if (process.env.NODE_APP_INSTANCE == '0') {
        await this.clientService.deleteAll();
      }
      setTimeout(() => {
        this.startSocketServer();
      }, 1000 * 10)

  }

  private startSocketServer() {
    const server = new Server(async (socket: Socket) => {

      //5 min
      socket.setTimeout(1000 * 60 * 5);

      const client = new StratumV1Client(
        socket,
        this.stratumV1JobsService,
        this.clientService,
        this.clientStatisticsService,
      );


      socket.on('close', async (hadError: boolean) => {
        if (client.extraNonceAndSessionId != null) {
          // Handle socket disconnection
          await client.destroy();
          console.log(`Client ${client.extraNonceAndSessionId} disconnected, hadError?:${hadError}`);
        }
      });

      socket.on('timeout', () => {
        console.log('socket timeout');
        socket.end();
        socket.destroy();
      });

      socket.on('error', async (error: Error) => { });
    });

    server.listen(process.env.STRATUM_PORT, () => {
      console.log(`Stratum server is listening on port ${process.env.STRATUM_PORT}`);
    });
  }
}