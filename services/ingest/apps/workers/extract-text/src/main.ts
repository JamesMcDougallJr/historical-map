import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExtractTextModule } from "./extract-text.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(ExtractTextModule);
  const port = Number(process.env["PORT"]) || 3105;
  await app.listen(port);
  new Logger("extract-text").log(`extract-text listening on :${port}`);
}

void bootstrap();
