import { DecorationRangeBehavior, Selection } from "vscode";
import { flatten } from "lodash";
import {
  Action,
  ActionPreferences,
  ActionReturnValue,
  Edit,
  Graph,
  SelectionWithEditor,
  TypedSelection,
} from "../typings/Types";
import { runOnTargetsForEachEditor } from "../util/targetUtils";
import { decorationSleep } from "../util/editDisplayUtils";
import { FullSelectionInfo } from "../typings/updateSelections";
import {
  getSelectionInfo,
  performEditsAndUpdateFullSelectionInfos,
} from "../core/updateSelections/updateSelections";

export default class Wrap implements Action {
  getTargetPreferences: () => ActionPreferences[] = () => [
    { insideOutsideType: "inside" },
  ];

  constructor(private graph: Graph) {
    this.run = this.run.bind(this);
  }

  async run(
    [targets]: [TypedSelection[]],
    left: string,
    right: string
  ): Promise<ActionReturnValue> {
    const excludeInteriorTargets = targets.filter(
      (target) => target.selectionContext.excludeInterior
    );
    targets = targets.filter(
      (target) => !target.selectionContext.excludeInterior
    );

    const thatMark = [];

    // Only bounds are selected. Rewrapping existing bounds makes no sense. Replace them instead.
    if (excludeInteriorTargets.length) {
      const { thatMark: replaceThatMark } =
        await this.graph.actions.replace.run(
          [excludeInteriorTargets],
          excludeInteriorTargets.map((t, i) => (i % 2 === 0 ? left : right))
        );
      thatMark.push(...replaceThatMark!);
    }

    thatMark.push(
      ...flatten(
        await runOnTargetsForEachEditor<SelectionWithEditor[]>(
          targets,
          async (editor, targets) => {
            const { document } = editor;
            const boundaries = targets.map((target) => ({
              start: new Selection(
                target.selection.selection.start,
                target.selection.selection.start
              ),
              end: new Selection(
                target.selection.selection.end,
                target.selection.selection.end
              ),
            }));

            const edits: Edit[] = boundaries.flatMap(({ start, end }) => [
              {
                text: left,
                range: start,
              },
              {
                text: right,
                range: end,
                isReplace: true,
              },
            ]);

            const delimiterSelectionInfos: FullSelectionInfo[] =
              boundaries.flatMap(({ start, end }) => {
                return [
                  getSelectionInfo(
                    document,
                    start,
                    DecorationRangeBehavior.OpenClosed
                  ),
                  getSelectionInfo(
                    document,
                    end,
                    DecorationRangeBehavior.ClosedOpen
                  ),
                ];
              });

            const cursorSelectionInfos = editor.selections.map((selection) =>
              getSelectionInfo(
                document,
                selection,
                DecorationRangeBehavior.ClosedClosed
              )
            );

            const thatMarkSelectionInfos = targets.map(
              ({ selection: { selection } }) =>
                getSelectionInfo(
                  document,
                  selection,
                  DecorationRangeBehavior.OpenOpen
                )
            );

            const [delimiterSelections, cursorSelections, thatMarkSelections] =
              await performEditsAndUpdateFullSelectionInfos(
                this.graph.rangeUpdater,
                editor,
                edits,
                [
                  delimiterSelectionInfos,
                  cursorSelectionInfos,
                  thatMarkSelectionInfos,
                ]
              );

            editor.selections = cursorSelections;

            editor.setDecorations(
              this.graph.editStyles.justAdded.token,
              delimiterSelections
            );
            await decorationSleep();
            editor.setDecorations(this.graph.editStyles.justAdded.token, []);

            return thatMarkSelections.map((selection) => ({
              editor,
              selection,
            }));
          }
        )
      )
    );

    return { thatMark };
  }
}
