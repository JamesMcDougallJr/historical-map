import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { IngestDocument, IngestReviewItem } from "@app/database";
import { DocumentsController } from "./documents.controller";

@Module({
  imports: [TypeOrmModule.forFeature([IngestDocument, IngestReviewItem])],
  controllers: [DocumentsController],
})
export class DocumentsModule {}
