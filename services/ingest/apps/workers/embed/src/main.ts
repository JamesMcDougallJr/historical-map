import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { EmbedModule } from "./embed.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(EmbedModule);
  app.enableShutdownHooks();
  const port = Number(process.env["PORT"]) || 3107;
  await app.listen(port);
  new Logger("embed").log(`embed listening on :${port}`);
}

void bootstrap();
