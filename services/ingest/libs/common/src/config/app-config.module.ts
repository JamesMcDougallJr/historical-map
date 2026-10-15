import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { validateEnv } from "./env-validation.schema";

/**
 * `isGlobal: true` means every app that imports this once gets an injectable
 * `ConfigService` everywhere, with no re-export and no per-module provider
 * list. Every app's root module imports it first.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // `.env.local` first (first file wins, and real process env beats both):
      // it is gitignored, so it is where a personal secret like JEV_API_KEY
      // belongs — plain `.env` is not ignored in this repo.
      envFilePath: [".env.local", ".env"],
      validate: validateEnv,
    }),
  ],
})
export class AppConfigModule {}
