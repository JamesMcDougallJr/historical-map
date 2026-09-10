import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FetchModule } from "./fetch.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(FetchModule);

  // Every app serves /health, including the workers — an orchestrator needs a
  // liveness signal from a process that otherwise only talks to Redis.
  const port = Number(process.env["PORT"]) || 3102;
  await app.listen(port);
  new Logger("fetch").log(`fetch listening on :${port}`);
}

void bootstrap();
