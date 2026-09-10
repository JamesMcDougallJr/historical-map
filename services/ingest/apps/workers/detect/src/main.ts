import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DetectModule } from "./detect.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(DetectModule);

  // Every app serves /health, including the workers — an orchestrator needs a
  // liveness signal from a process that otherwise only talks to Redis.
  const port = Number(process.env["PORT"]) || 3101;
  await app.listen(port);
  new Logger("detect").log(`detect listening on :${port}`);
}

void bootstrap();
