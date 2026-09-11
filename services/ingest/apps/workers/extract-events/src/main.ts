import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExtractEventsModule } from "./extract-events.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(ExtractEventsModule);

  // Every app serves /health, including the workers — an orchestrator needs a
  // liveness signal from a process that otherwise only talks to Redis.
  const port = Number(process.env["PORT"]) || 3103;
  await app.listen(port);
  new Logger("extract-events").log(`extract listening on :${port}`);
}

void bootstrap();
