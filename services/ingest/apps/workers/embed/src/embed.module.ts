import { Module } from "@nestjs/common";
import { AppConfigModule, HealthController } from "@app/common";
import { DatabaseModule } from "@app/database";
import { EmbeddingModule } from "@app/embedding";
import { EmbedSweepService } from "./embed-sweep.service";

@Module({
  imports: [AppConfigModule, DatabaseModule, EmbeddingModule],
  controllers: [HealthController],
  providers: [EmbedSweepService],
})
export class EmbedModule {}
