import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ValidateModule } from "./validate.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(ValidateModule);
  const port = Number(process.env["PORT"]) || 3106;
  await app.listen(port);
  new Logger("validate").log(`validate listening on :${port}`);
}

void bootstrap();
