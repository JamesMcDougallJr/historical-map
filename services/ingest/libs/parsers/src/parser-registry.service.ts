import { Inject, Injectable } from "@nestjs/common";
import {
  DOCUMENT_PARSERS,
  type DocumentParser,
  type ParsedDocument,
} from "./document-parser.interface";

/** Thrown when no parser claims a document — a real, actionable condition. */
export class NoParserError extends Error {
  constructor(contentType: string | null, path: string) {
    super(`No parser for contentType=${contentType ?? "null"} path=${path}`);
    this.name = "NoParserError";
  }
}

@Injectable()
export class ParserRegistry {
  constructor(
    @Inject(DOCUMENT_PARSERS) private readonly parsers: DocumentParser[],
  ) {}

  /**
   * First match wins, so **registration order is significant**: the text parser
   * deliberately accepts a null content type as a catch-all, so it must come
   * last or it would swallow PDFs whose server forgot to label them.
   */
  select(contentType: string | null, path: string): DocumentParser {
    const parser = this.parsers.find((p) => p.canParse(contentType, path));
    if (!parser) throw new NoParserError(contentType, path);
    return parser;
  }

  async parse(
    bytes: Buffer,
    contentType: string | null,
    path: string,
  ): Promise<ParsedDocument & { kind: string }> {
    const parser = this.select(contentType, path);
    const parsed = await parser.parse(bytes);
    return { ...parsed, kind: parser.kind };
  }
}
