import {
  Action,
  ActionPreferences,
  ActionReturnValue,
  Graph,
  TypedSelection,
} from "../typings/Types";
import { ensureSingleTarget } from "../util/targetUtils";
import { range, repeat, zip } from "lodash";
import displayPendingEditDecorations from "../util/editDisplayUtils";
import { performEditsAndUpdateSelections } from "../util/updateSelections";
import { performDocumentEdits } from "../util/performDocumentEdits";
import { SnippetString, window, workspace } from "vscode";
import { join } from "path";
import { open } from "fs/promises";

export default class GenerateSnippet implements Action {
  getTargetPreferences: () => ActionPreferences[] = () => [
    { insideOutsideType: "inside" },
  ];

  constructor(private graph: Graph) {
    this.run = this.run.bind(this);
  }

  async run(
    [targets]: [TypedSelection[]],
    snippetName?: string
  ): Promise<ActionReturnValue> {
    const target = ensureSingleTarget(targets);
    const editor = target.selection.editor;

    if (snippetName == null) {
      snippetName = await window.showInputBox({
        prompt: "Name of snippet",
        placeHolder: "helloWorld",
      });
    }

    if (snippetName == null) {
      return {};
    }

    await displayPendingEditDecorations(
      targets,
      this.graph.editStyles.referenced
    );

    let placeholderIndex = 1;

    const originalSelections = editor.selections.filter(
      (selection) =>
        !selection.isEmpty && target.selection.selection.contains(selection)
    );
    const originalSelectionTexts = originalSelections.map((selection) =>
      editor.document.getText(selection)
    );

    const substituter = new Substituter();

    const [placeholderRanges, [targetSelection]] =
      await performEditsAndUpdateSelections(
        editor,
        originalSelections.map((selection) => ({
          editor,
          range: selection,
          text: substituter.addSubstitution(`\\$$${placeholderIndex++}`),
        })),
        [originalSelections, [target.selection.selection]]
      );

    const snippetLines: string[] = [];
    let currentTabCount = 0;
    let currentIndentationString: string | null = null;

    const { start, end } = targetSelection;
    const startLine = start.line;
    const endLine = end.line;
    range(startLine, endLine + 1).forEach((lineNumber) => {
      const line = editor.document.lineAt(lineNumber);
      const { text, firstNonWhitespaceCharacterIndex } = line;
      const newIndentationString = text.substring(
        0,
        firstNonWhitespaceCharacterIndex
      );

      if (currentIndentationString != null) {
        if (newIndentationString.length > currentIndentationString.length) {
          currentTabCount++;
        } else if (
          newIndentationString.length < currentIndentationString.length
        ) {
          currentTabCount--;
        }
      }

      currentIndentationString = newIndentationString;

      const lineContentStart = Math.max(
        firstNonWhitespaceCharacterIndex,
        lineNumber === startLine ? start.character : 0
      );
      const lineContentEnd = Math.min(
        text.length,
        lineNumber === endLine ? end.character : Infinity
      );
      const snippetIndentationString = repeat("\t", currentTabCount);
      const lineContent = text.substring(lineContentStart, lineContentEnd);
      snippetLines.push(snippetIndentationString + lineContent);
    });

    await performDocumentEdits(
      editor,
      zip(placeholderRanges, originalSelectionTexts).map(([range, text]) => ({
        editor,
        range: range!,
        text: text!,
      }))
    );

    const snippet = {
      [snippetName]: {
        definitions: [
          {
            scope: {
              langIds: [editor.document.languageId],
            },
            body: snippetLines,
          },
        ],
        description: `$${placeholderIndex++}`,
        variables:
          originalSelections.length === 0
            ? undefined
            : Object.fromEntries(
                range(originalSelections.length).map((index) => [
                  `$${index + 1}`,
                  substituter.addSubstitution(`{$${placeholderIndex++}}`, true),
                ])
              ),
      },
    };
    const snippetText = substituter.makeSubstitutions(
      JSON.stringify(snippet, null, 2)
    );
    console.log(snippetText);
    const userSnippetsDir = workspace
      .getConfiguration("cursorless.experimental")
      .get<string>("snippetsDir");

    if (!userSnippetsDir) {
      throw new Error("User snippets dir not configured.");
    }

    const path = join(userSnippetsDir, `${snippetName}.cursorless-snippets`);
    await touch(path);
    const snippetDoc = await workspace.openTextDocument(path);
    const snippetEditor = await window.showTextDocument(snippetDoc);
    snippetEditor.insertSnippet(new SnippetString(snippetText));

    return {
      thatMark: targets.map((target) => target.selection),
    };
  }
}

interface Substitution {
  randomId: string;
  to: string;
  isQuoted: boolean;
}

class Substituter {
  private substitutions: Substitution[] = [];

  addSubstitution(to: string, isQuoted: boolean = false) {
    const randomId = makeid(10);

    this.substitutions.push({
      to,
      randomId,
      isQuoted,
    });

    return randomId;
  }

  makeSubstitutions(text: string) {
    this.substitutions.forEach(({ to, randomId, isQuoted }) => {
      const from = isQuoted ? `"${randomId}"` : randomId;
      // NB: We use split / join instead of replace because the latter doesn't
      // handle dollar signs well
      text = text.split(from).join(to);
    });

    return text;
  }
}

// From https://stackoverflow.com/a/1349426/2605678
function makeid(length: number) {
  var result = "";
  var characters =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  var charactersLength = characters.length;
  for (var i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  return result;
}

async function touch(path: string) {
  const file = await open(path, "w");
  await file.close();
}