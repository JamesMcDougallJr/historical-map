import { Module } from "@nestjs/common";
import {
  DOCUMENT_PARSERS,
  type DocumentParser,
} from "./document-parser.interface";
import { ParserRegistry } from "./parser-registry.service";
import { HtmlParser } from "./parsers/html.parser";
import { PdfParser } from "./parsers/pdf.parser";
import { TextParser } from "./parsers/text.parser";

/**
 * Order is load-bearing — `ParserRegistry.select` takes the first match, and
 * `TextParser` is a deliberate catch-all. Adding a format means adding a class
 * and one line here.
 */
const PARSERS: DocumentParser[] = [
  new PdfParser(),
  new HtmlParser(),
  new TextParser(),
];

@Module({
  providers: [{ provide: DOCUMENT_PARSERS, useValue: PARSERS }, ParserRegistry],
  exports: [ParserRegistry, DOCUMENT_PARSERS],
})
export class ParsersModule {}
