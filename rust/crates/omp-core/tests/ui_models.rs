use omp_core::geometry::{UiGeometry, resolve_layout};
use omp_core::turn_changes::{FileSnapshot, TurnBaseline, compute_turn_changes};

#[test]
fn resolves_three_docked_columns_on_a_wide_window() {
    let layout = resolve_layout(1200.0, &UiGeometry::default());
    assert!(layout.sidebar_docked);
    assert!(layout.right_pane_docked);
    assert_eq!(layout.sidebar_width, 248.0);
    assert_eq!(layout.right_pane_width, 360.0);
    assert_eq!(layout.center_width, 592.0);
    assert!(layout.overlay.is_none());
}

#[test]
fn collapses_the_right_pane_before_the_center_drops_below_360px() {
    let geometry = UiGeometry {
        sidebar_width: 480.0,
        right_pane_width: 720.0,
        ..UiGeometry::default()
    };

    let wide = resolve_layout(1200.0, &geometry);
    assert!(wide.right_pane_docked);
    assert_eq!(wide.right_pane_width, 360.0);
    assert!(wide.center_width >= 360.0);

    let compact = resolve_layout(1000.0, &geometry);
    assert!(!compact.right_pane_docked);
    assert_eq!(compact.overlay.as_deref(), Some("rightPane"));
    assert!(compact.center_width >= 360.0);

    let narrow = resolve_layout(900.0, &geometry);
    assert!(!narrow.right_pane_docked);
    assert_eq!(narrow.overlay.as_deref(), Some("rightPane"));
    assert!(narrow.center_width >= 360.0);
}

#[test]
fn collapses_both_panes_to_overlays_on_a_small_window() {
    let layout = resolve_layout(700.0, &UiGeometry::default());
    assert!(!layout.sidebar_docked);
    assert!(!layout.right_pane_docked);
    assert_eq!(layout.overlay.as_deref(), Some("rightPane"));
}

#[test]
fn turn_changes_only_report_what_this_turn_added() {
    let baseline = TurnBaseline::capture([
        FileSnapshot {
            path: "pre-dirty.ts".into(),
            additions: 2,
            deletions: 1,
            staged: false,
        },
        FileSnapshot {
            path: "untouched.ts".into(),
            additions: 4,
            deletions: 0,
            staged: false,
        },
    ]);
    let changes = compute_turn_changes(
        &baseline,
        [
            FileSnapshot {
                path: "pre-dirty.ts".into(),
                additions: 5,
                deletions: 1,
                staged: false,
            },
            FileSnapshot {
                path: "untouched.ts".into(),
                additions: 4,
                deletions: 0,
                staged: false,
            },
            FileSnapshot {
                path: "new.ts".into(),
                additions: 3,
                deletions: 2,
                staged: false,
            },
        ],
    );
    assert_eq!(changes.files.len(), 2);
    assert_eq!(changes.files[0].path, "new.ts");
    assert_eq!(changes.files[0].additions, 3);
    assert_eq!(changes.files[1].path, "pre-dirty.ts");
    assert_eq!(changes.files[1].additions, 3);
    assert_eq!(changes.files[1].deletions, 0);
    assert_eq!(changes.additions, 6);
    assert_eq!(changes.deletions, 2);
}

#[test]
fn a_clean_baseline_reports_a_new_file() {
    let baseline = TurnBaseline::capture(Vec::new());
    let changes = compute_turn_changes(
        &baseline,
        [FileSnapshot {
            path: "new.ts".into(),
            additions: 3,
            deletions: 0,
            staged: false,
        }],
    );
    assert_eq!(changes.files.len(), 1);
    assert_eq!(changes.files[0].path, "new.ts");
    assert_eq!(changes.additions, 3);
}

#[test]
fn an_unchanged_turn_produces_no_card() {
    let baseline = TurnBaseline::capture([FileSnapshot {
        path: "a.ts".into(),
        additions: 1,
        deletions: 1,
        staged: false,
    }]);
    let changes = compute_turn_changes(
        &baseline,
        [FileSnapshot {
            path: "a.ts".into(),
            additions: 1,
            deletions: 1,
            staged: false,
        }],
    );
    assert!(changes.is_empty());
}
