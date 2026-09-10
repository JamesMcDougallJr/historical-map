import "reflect-metadata";
import { Logger, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ApiModule } from "./api.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(ApiModule);
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));

  // Every app serves /health, including the workers — an orchestrator needs a
  // liveness signal from a process that otherwise only talks to Redis.
  const port = Number(process.env["PORT"]) || 3100;
  await app.listen(port);
  new Logger("api").log(`api listening on :${port}`);
}

void bootstrap();
