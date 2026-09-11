import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { PublishModule } from "./publish.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(PublishModule);

  // Every app serves /health, including the workers — an orchestrator needs a
  // liveness signal from a process that otherwise only talks to Redis.
  const port = Number(process.env["PORT"]) || 3104;
  await app.listen(port);
  new Logger("publish").log(`publish listening on :${port}`);
}

void bootstrap();
