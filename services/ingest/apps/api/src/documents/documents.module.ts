import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { IngestDocument, IngestEventCandidate } from "@app/database";
import { DocumentsController } from "./documents.controller";

@Module({
  imports: [TypeOrmModule.forFeature([IngestDocument, IngestEventCandidate])],
  controllers: [DocumentsController],
})
export class DocumentsModule {}
