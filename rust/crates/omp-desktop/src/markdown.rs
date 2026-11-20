//! CommonMark rendering for assistant transcript text.
//!
//! [`render_markdown`] is the whole public surface. It parses the text with
//! `pulldown-cmark`, lowers the event stream into a small block model, and
//! builds GPUI elements from it. Nothing here touches a window, a clipboard, or
//! any state, so a transcript row can rebuild its elements on every frame.
//!
//! The parse step is separated from the element build so it can be tested
//! without a window: [`parse_blocks`] is pure, and the tests below assert on
//! what it recognises.

use gpui_kit::InteractiveElement as _;
use std::rc::Rc;

use gpui_kit::assets::IconName;

/// Clipboard sink for a code block's Copy button.
type CopyHandler = Rc<dyn Fn(&str, &mut Window, &mut App)>;
use gpui_kit::component::ThemeColor;
use gpui_kit::*;
use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};

/// Body text size, in pixels. Headings scale from this.
const BODY_FONT_SIZE: f32 = 14.0;
/// Body line height as a multiple of the font size (≈22.7px).
const BODY_LINE_HEIGHT: f32 = 1.62;
/// Heading line height as a multiple of the font size.
const HEADING_LINE_HEIGHT: f32 = 1.35;
/// Code size, in pixels, for both fenced blocks and inline spans.
const CODE_FONT_SIZE: f32 = 12.5;
/// Code line height as a multiple of the font size.
const CODE_LINE_HEIGHT: f32 = 1.55;
/// Corner radius of a fenced code block.
const CODE_RADIUS: f32 = 12.0;
/// Left border width of a block quote.
const QUOTE_BORDER: f32 = 3.0;
/// Horizontal space a list marker takes before the item's text.
const LIST_INDENT: f32 = 22.0;
/// Space between two sibling blocks.
const BLOCK_GAP: f32 = 8.0;
/// Space between two blocks inside one list item or quote.
const INNER_GAP: f32 = 4.0;

// ---------------------------------------------------------------------------
// Block model
// ---------------------------------------------------------------------------

/// The inline emphasis carried by one run of text.
///
/// Flags are independent so `***bold italic***` and a link around bold text
/// both resolve to one run each, and a run never overlaps its neighbour.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct InlineStyle {
    bold: bool,
    italic: bool,
    code: bool,
    link: bool,
    strike: bool,
}

/// A run of text with one resolved style.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Span {
    text: String,
    style: InlineStyle,
}

/// One block of the document, in reading order.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Block {
    Heading {
        level: u8,
        spans: Vec<Span>,
    },
    Paragraph(Vec<Span>),
    Code {
        /// The first word of the fence's info string; `None` for an indented
        /// block or a fence with no language.
        language: Option<String>,
        text: String,
    },
    List {
        ordered: bool,
        /// The number the first ordered item shows. Unused when unordered.
        start: u64,
        /// One entry per item; an item holds its own blocks, so a nested list
        /// stays inside the item that contains it.
        items: Vec<Vec<Block>>,
    },
    Quote(Vec<Block>),
    Rule,
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/// The CommonMark extensions the transcript renders. Tables, footnotes and
/// definition lists stay off, so their syntax arrives as ordinary text instead
/// of a half-rendered structure.
fn options() -> Options {
    Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS
}

/// Emphasis currently open, counted so nested markup unwinds in order.
#[derive(Default, Clone, Copy)]
struct InlineDepth {
    strong: u32,
    emphasis: u32,
    link: u32,
    strike: u32,
}

impl InlineDepth {
    fn style(self) -> InlineStyle {
        InlineStyle {
            bold: self.strong > 0,
            italic: self.emphasis > 0,
            code: false,
            link: self.link > 0,
            strike: self.strike > 0,
        }
    }
}

/// What a frame collects while its element is open.
enum FrameKind {
    Root,
    Paragraph,
    /// The level comes from the `End` event, which carries it too.
    Heading,
    Quote,
    List {
        ordered: bool,
        start: u64,
        items: Vec<Vec<Block>>,
    },
    Item,
    Code {
        language: Option<String>,
        text: String,
    },
}

/// One open block element. Inline text arrives in `spans`; finished blocks land
/// in `blocks`, in document order.
struct Frame {
    kind: FrameKind,
    blocks: Vec<Block>,
    spans: Vec<Span>,
}

impl Frame {
    fn new(kind: FrameKind) -> Self {
        Self {
            kind,
            blocks: Vec::new(),
            spans: Vec::new(),
        }
    }
}

/// Lower CommonMark `text` into blocks.
///
/// `pulldown-cmark` is infallible and its `Start`/`End` events are balanced, but
/// a frame that is missing still degrades to "keep the text" rather than
/// panicking.
fn parse_blocks(text: &str) -> Vec<Block> {
    let mut stack = vec![Frame::new(FrameKind::Root)];
    let mut depth = InlineDepth::default();
    for event in Parser::new_ext(text, options()) {
        match event {
            Event::Start(tag) => start_tag(tag, &mut stack, &mut depth),
            Event::End(tag) => end_tag(tag, &mut stack, &mut depth),
            Event::Text(text) => push_text(&mut stack, &text, depth.style()),
            Event::Code(code) => {
                let style = InlineStyle {
                    code: true,
                    ..depth.style()
                };
                push_text(&mut stack, &code, style);
            }
            // Math needs `Options::ENABLE_MATH`, which is off; if it is ever
            // turned on the expression still shows, set like inline code.
            Event::InlineMath(math) | Event::DisplayMath(math) => {
                let style = InlineStyle {
                    code: true,
                    ..depth.style()
                };
                push_text(&mut stack, &math, style);
            }
            // Raw HTML has no GPUI equivalent; its source is the fallback.
            Event::Html(html) | Event::InlineHtml(html) => {
                push_text(&mut stack, &html, depth.style());
            }
            Event::FootnoteReference(label) => {
                push_text(&mut stack, &format!("[^{label}]"), depth.style());
            }
            Event::SoftBreak => push_text(&mut stack, " ", depth.style()),
            Event::HardBreak => push_text(&mut stack, "\n", depth.style()),
            Event::Rule => push_block(&mut stack, Block::Rule),
            Event::TaskListMarker(checked) => {
                let marker = if checked { "☑ " } else { "☐ " };
                push_text(&mut stack, marker, depth.style());
            }
        }
    }
    finish(stack)
}

fn start_tag(tag: Tag<'_>, stack: &mut Vec<Frame>, depth: &mut InlineDepth) {
    match tag {
        Tag::Paragraph => stack.push(Frame::new(FrameKind::Paragraph)),
        Tag::Heading { .. } => stack.push(Frame::new(FrameKind::Heading)),
        Tag::BlockQuote(_) => stack.push(Frame::new(FrameKind::Quote)),
        Tag::CodeBlock(kind) => stack.push(Frame::new(FrameKind::Code {
            language: code_language(kind),
            text: String::new(),
        })),
        Tag::List(start) => stack.push(Frame::new(FrameKind::List {
            ordered: start.is_some(),
            start: start.unwrap_or(1),
            items: Vec::new(),
        })),
        Tag::Item => stack.push(Frame::new(FrameKind::Item)),
        Tag::Emphasis => depth.emphasis += 1,
        Tag::Strong => depth.strong += 1,
        Tag::Strikethrough => depth.strike += 1,
        Tag::Link { .. } | Tag::Image { .. } => depth.link += 1,
        // Superscript and subscript have no GPUI text run, so they flatten to
        // plain text; the text itself is never dropped.
        Tag::Superscript | Tag::Subscript => {}
        // Block containers the renderer has no element for. Their text still
        // lands in the enclosing frame's inline buffer and is flushed as a
        // paragraph, so nothing is lost.
        Tag::HtmlBlock
        | Tag::FootnoteDefinition(_)
        | Tag::DefinitionList
        | Tag::DefinitionListTitle
        | Tag::DefinitionListDefinition
        | Tag::Table(_)
        | Tag::TableHead
        | Tag::TableRow
        | Tag::TableCell
        | Tag::MetadataBlock(_) => {}
    }
}

fn end_tag(tag: TagEnd, stack: &mut Vec<Frame>, depth: &mut InlineDepth) {
    match tag {
        TagEnd::Paragraph => {
            if let Some(frame) = stack.pop() {
                push_block(stack, Block::Paragraph(trim_end(frame.spans)));
            }
        }
        TagEnd::Heading(level) => {
            if let Some(frame) = stack.pop() {
                push_block(
                    stack,
                    Block::Heading {
                        level: heading_number(level),
                        spans: trim_end(frame.spans),
                    },
                );
            }
        }
        TagEnd::BlockQuote(_) => {
            if let Some(mut frame) = stack.pop() {
                flush_spans(&mut frame);
                push_block(stack, Block::Quote(frame.blocks));
            }
        }
        TagEnd::CodeBlock => {
            if let Some(frame) = stack.pop()
                && let FrameKind::Code { language, text } = frame.kind
            {
                push_block(
                    stack,
                    Block::Code {
                        language,
                        text: normalize_code(text),
                    },
                );
            }
        }
        TagEnd::List(_) => {
            if let Some(mut frame) = stack.pop() {
                flush_spans(&mut frame);
                if let FrameKind::List {
                    ordered,
                    start,
                    items,
                } = frame.kind
                {
                    push_block(
                        stack,
                        Block::List {
                            ordered,
                            start,
                            items,
                        },
                    );
                }
            }
        }
        TagEnd::Item => {
            if let Some(mut frame) = stack.pop() {
                flush_spans(&mut frame);
                if let Some(parent) = stack.last_mut()
                    && let FrameKind::List { items, .. } = &mut parent.kind
                {
                    items.push(frame.blocks);
                    return;
                }
                // An item outside a list cannot happen with `pulldown-cmark`;
                // keep its blocks in place instead of discarding them.
                for block in frame.blocks {
                    push_block(stack, block);
                }
            }
        }
        TagEnd::Emphasis => depth.emphasis = depth.emphasis.saturating_sub(1),
        TagEnd::Strong => depth.strong = depth.strong.saturating_sub(1),
        TagEnd::Strikethrough => depth.strike = depth.strike.saturating_sub(1),
        TagEnd::Link | TagEnd::Image => depth.link = depth.link.saturating_sub(1),
        TagEnd::Superscript
        | TagEnd::Subscript
        | TagEnd::HtmlBlock
        | TagEnd::FootnoteDefinition
        | TagEnd::DefinitionList
        | TagEnd::DefinitionListTitle
        | TagEnd::DefinitionListDefinition
        | TagEnd::Table
        | TagEnd::TableHead
        | TagEnd::TableRow
        | TagEnd::TableCell
        | TagEnd::MetadataBlock(_) => {}
    }
}

/// Append text to the innermost open element: a code block keeps it verbatim,
/// anything else merges it into the inline buffer.
fn push_text(stack: &mut [Frame], text: &str, style: InlineStyle) {
    let Some(frame) = stack.last_mut() else {
        return;
    };
    if let FrameKind::Code { text: code, .. } = &mut frame.kind {
        code.push_str(text);
        return;
    }
    if text.is_empty() {
        return;
    }
    match frame.spans.last_mut() {
        Some(last) if last.style == style => last.text.push_str(text),
        _ => frame.spans.push(Span {
            text: text.to_string(),
            style,
        }),
    }
}

/// Add a finished block to the innermost open element, flushing any inline text
/// that came before it so reading order is kept.
fn push_block(stack: &mut [Frame], block: Block) {
    let Some(frame) = stack.last_mut() else {
        return;
    };
    flush_spans(frame);
    match &mut frame.kind {
        FrameKind::List { items, .. } => items.push(vec![block]),
        _ => frame.blocks.push(block),
    }
}

/// Turn the inline buffer into a paragraph block. A list has no place for a
/// bare paragraph, so the text becomes a synthetic item.
fn flush_spans(frame: &mut Frame) {
    let spans = trim_end(std::mem::take(&mut frame.spans));
    if spans.is_empty() {
        return;
    }
    let paragraph = Block::Paragraph(spans);
    match &mut frame.kind {
        FrameKind::List { items, .. } => items.push(vec![paragraph]),
        _ => frame.blocks.push(paragraph),
    }
}

/// Drop trailing whitespace so a paragraph does not end with an empty line
/// (HTML blocks and indented code hand their text over with a trailing newline).
fn trim_end(mut spans: Vec<Span>) -> Vec<Span> {
    while let Some(last) = spans.last_mut() {
        let trimmed = last.text.trim_end().len();
        if trimmed == 0 {
            spans.pop();
            continue;
        }
        last.text.truncate(trimmed);
        break;
    }
    spans
}

/// Unwind the frames left after the event stream ends. Balanced input leaves
/// only the root frame; anything else is folded in, in order, without panicking.
fn finish(mut stack: Vec<Frame>) -> Vec<Block> {
    let mut blocks = Vec::new();
    while let Some(mut frame) = stack.pop() {
        flush_spans(&mut frame);
        frame.blocks.append(&mut blocks);
        blocks = frame.blocks;
    }
    blocks
}

fn heading_number(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

/// The language label of a code block: the first word of the fence's info
/// string, or `None` for an indented block.
fn code_language(kind: CodeBlockKind<'_>) -> Option<String> {
    match kind {
        CodeBlockKind::Indented => None,
        CodeBlockKind::Fenced(info) => info
            .split_whitespace()
            .next()
            .map(str::to_string)
            .filter(|language| !language.is_empty()),
    }
}

/// The label a code block's header shows. An indented block, or a fence with no
/// language, is labelled `text`.
fn code_label(language: Option<&str>) -> &str {
    match language {
        Some(language) if !language.trim().is_empty() => language,
        _ => "text",
    }
}

/// Drop the single newline the parser leaves at the end of a code block; the
/// lines inside keep their breaks.
fn normalize_code(mut text: String) -> String {
    if text.ends_with('\n') {
        text.pop();
        if text.ends_with('\r') {
            text.pop();
        }
    }
    text
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/// Render CommonMark `text` as GPUI elements.
///
/// The function is pure: it takes the text and the theme colors it should draw
/// with, and returns an element tree. It never reads a window, the clipboard,
/// or any app state, so the caller can rebuild it whenever the text changes.
pub fn render_markdown(
    text: &str,
    colors: ThemeColor,
    on_copy: impl Fn(&str, &mut Window, &mut App) + 'static,
) -> AnyElement {
    let blocks = parse_blocks(text);
    // Code blocks number themselves in document order: the scroll container
    // needs a stable id to keep its offset between frames, and the order is
    // what stays stable while a reply streams in.
    let mut code_blocks = 0;
    let on_copy: CopyHandler = Rc::new(on_copy);
    render_blocks(
        &blocks,
        colors,
        colors.foreground,
        &mut code_blocks,
        &on_copy,
    )
    .into_any_element()
}

fn render_blocks(
    blocks: &[Block],
    colors: ThemeColor,
    text_color: Hsla,
    code_blocks: &mut usize,
    on_copy: &CopyHandler,
) -> Div {
    div().flex().flex_col().gap(px(BLOCK_GAP)).children(
        blocks
            .iter()
            .map(|block| render_block(block, colors, text_color, code_blocks, on_copy)),
    )
}

fn render_block(
    block: &Block,
    colors: ThemeColor,
    text_color: Hsla,
    code_blocks: &mut usize,
    on_copy: &CopyHandler,
) -> AnyElement {
    match block {
        Block::Paragraph(spans) => {
            text_element(spans, colors, text_color, BODY_FONT_SIZE, BODY_LINE_HEIGHT)
        }
        Block::Heading { level, spans } => heading(*level, spans, colors, text_color),
        Block::Code { language, text } => {
            let index = *code_blocks;
            *code_blocks += 1;
            code_block(index, language.as_deref(), text, colors, on_copy)
        }
        Block::List {
            ordered,
            start,
            items,
        } => list(
            *ordered,
            *start,
            items,
            colors,
            text_color,
            code_blocks,
            on_copy,
        ),
        Block::Quote(blocks) => quote(blocks, colors, code_blocks, on_copy),
        Block::Rule => div()
            .w_full()
            .h(px(1.0))
            .bg(colors.border)
            .into_any_element(),
    }
}

/// A run of inline spans at one size. The parent's text style is the default
/// for the runs inside it.
fn text_element(
    spans: &[Span],
    colors: ThemeColor,
    text_color: Hsla,
    size: f32,
    line_height: f32,
) -> AnyElement {
    div()
        .text_size(px(size))
        .line_height(px(size * line_height))
        .text_color(text_color)
        .child(styled_text(spans, colors))
        .into_any_element()
}

fn heading(level: u8, spans: &[Span], colors: ThemeColor, text_color: Hsla) -> AnyElement {
    let scale = match level {
        1 => 1.32,
        2 => 1.2,
        3 => 1.05,
        _ => 1.0,
    };
    div()
        .text_size(px(BODY_FONT_SIZE * scale))
        .line_height(px(BODY_FONT_SIZE * scale * HEADING_LINE_HEIGHT))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(text_color)
        .child(styled_text(spans, colors))
        .into_any_element()
}

/// One text element carrying every span as a styled run.
///
/// GPUI resolves highlight ranges against the inherited text style, so the
/// runs are built from non-overlapping spans (see [`InlineStyle`]) and the
/// monospace family is applied as a per-range font override.
fn styled_text(spans: &[Span], colors: ThemeColor) -> StyledText {
    let mut text = String::new();
    let mut highlights = Vec::new();
    let mut monospace = Vec::new();
    for span in spans {
        if span.text.is_empty() {
            continue;
        }
        let start = text.len();
        text.push_str(&span.text);
        let end = text.len();
        highlights.push((start..end, highlight(span.style, colors)));
        if span.style.code {
            monospace.push((start..end, SharedString::from(mono_family())));
        }
    }
    if text.is_empty() {
        return StyledText::new("");
    }
    StyledText::new(text)
        .with_highlights(highlights)
        .with_font_family_overrides(monospace)
}

fn highlight(style: InlineStyle, colors: ThemeColor) -> HighlightStyle {
    let mut highlight = HighlightStyle::default();
    if style.bold {
        highlight.font_weight = Some(FontWeight::BOLD);
    }
    if style.italic {
        highlight.font_style = Some(FontStyle::Italic);
    }
    if style.code {
        highlight.background_color = Some(colors.tab);
    }
    if style.link {
        highlight.color = Some(colors.link);
        highlight.underline = Some(UnderlineStyle {
            thickness: px(1.0),
            color: Some(colors.link),
            wavy: false,
        });
    }
    if style.strike {
        highlight.strikethrough = Some(StrikethroughStyle {
            thickness: px(1.0),
            color: None,
        });
    }
    highlight
}

/// A fenced code block: a header naming the language, then the code itself,
/// unwrapped so long lines scroll sideways instead of reflowing.
fn code_block(
    index: usize,
    language: Option<&str>,
    code: &str,
    colors: ThemeColor,
    on_copy: &CopyHandler,
) -> AnyElement {
    div()
        .flex()
        .flex_col()
        .w_full()
        .rounded(px(CODE_RADIUS))
        .border_1()
        .border_color(colors.border)
        .bg(colors.tab)
        .overflow_hidden()
        .child(
            div()
                .flex()
                .items_center()
                .px_3()
                .py_1()
                .border_b_1()
                .border_color(colors.border)
                .text_size(px(11.0))
                .text_color(colors.muted_foreground)
                .child(SharedString::from(code_label(language).to_string()))
                .child(div().flex_1())
                .child(
                    div()
                        .id(("markdown-code-copy", index))
                        .aria_label("Copy code")
                        .flex()
                        .items_center()
                        .gap_1()
                        .px_2()
                        .py_1()
                        .rounded(px(6.0))
                        .text_size(px(10.5))
                        .text_color(colors.muted_foreground)
                        .hover(|style| style.bg(colors.accent))
                        .child(IconName::Copy)
                        .child("Copy")
                        .on_click({
                            let on_copy = on_copy.clone();
                            let code = code.to_string();
                            move |_, window, cx| on_copy(&code, window, cx)
                        }),
                ),
        )
        .child(
            div()
                .id(("markdown-code-block", index))
                .flex()
                .flex_col()
                .items_start()
                .w_full()
                .overflow_x_scroll()
                .px_3()
                .py_2()
                .child(
                    div()
                        .whitespace_nowrap()
                        .text_size(px(CODE_FONT_SIZE))
                        .line_height(px(CODE_FONT_SIZE * CODE_LINE_HEIGHT))
                        .text_color(colors.foreground)
                        .font_family(mono_family())
                        .child(SharedString::from(code.to_string())),
                ),
        )
        .into_any_element()
}

fn list(
    ordered: bool,
    start: u64,
    items: &[Vec<Block>],
    colors: ThemeColor,
    text_color: Hsla,
    code_blocks: &mut usize,
    on_copy: &CopyHandler,
) -> AnyElement {
    div()
        .flex()
        .flex_col()
        .gap(px(INNER_GAP))
        .children(items.iter().enumerate().map(|(index, blocks)| {
            let marker = if ordered {
                format!("{}.", start + index as u64)
            } else {
                "•".to_string()
            };
            div()
                .flex()
                .items_start()
                .child(
                    div()
                        .flex_none()
                        .w(px(LIST_INDENT))
                        .text_size(px(BODY_FONT_SIZE))
                        .line_height(px(BODY_FONT_SIZE * BODY_LINE_HEIGHT))
                        .text_color(colors.muted_foreground)
                        .child(SharedString::from(marker)),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w(px(0.0))
                        .flex()
                        .flex_col()
                        .gap(px(INNER_GAP))
                        .children(blocks.iter().map(|block| {
                            render_block(block, colors, text_color, code_blocks, on_copy)
                        })),
                )
        }))
        .into_any_element()
}

fn quote(
    blocks: &[Block],
    colors: ThemeColor,
    code_blocks: &mut usize,
    on_copy: &CopyHandler,
) -> AnyElement {
    div()
        .flex()
        .flex_col()
        .gap(px(INNER_GAP))
        .pl_3()
        .border_l(px(QUOTE_BORDER))
        .border_color(colors.border)
        .children(blocks.iter().map(|block| {
            render_block(block, colors, colors.muted_foreground, code_blocks, on_copy)
        }))
        .into_any_element()
}

/// The monospace family for inline code and code blocks.
///
/// This mirrors `terminal::monospace_font`, which is private to the terminal
/// panel; keeping the choice local means the renderer works wherever it is
/// mounted. GPUI panics on a family it cannot load, so each platform names one
/// that ships with the system.
fn mono_family() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "Menlo"
    }
    #[cfg(target_os = "windows")]
    {
        "Consolas"
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        "monospace"
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    // Imported explicitly: `use super::*` would also pull in `gpui_kit`'s
    // `test` attribute macro, which shadows the built-in one.
    use gpui_kit::component::ThemeColor;

    use super::{Block, InlineStyle, Span, code_label, parse_blocks, render_markdown};

    /// The text of a run of spans, styles dropped.
    fn span_text(spans: &[Span]) -> String {
        spans.iter().map(|span| span.text.as_str()).collect()
    }

    /// Every piece of text in a document, so a fallback can be checked without
    /// caring where the text landed.
    fn document_text(blocks: &[Block]) -> String {
        let mut text = String::new();
        for block in blocks {
            match block {
                Block::Heading { spans, .. } | Block::Paragraph(spans) => {
                    text.push_str(&span_text(spans));
                }
                Block::Code { text: code, .. } => text.push_str(code),
                Block::List { items, .. } => {
                    for item in items {
                        text.push_str(&document_text(item));
                    }
                }
                Block::Quote(blocks) => text.push_str(&document_text(blocks)),
                Block::Rule => {}
            }
        }
        text
    }

    #[test]
    fn paragraph_splits_inline_styles() {
        let blocks = parse_blocks("Plain **bold** *italic* `code` [link](https://example.com)");
        assert_eq!(blocks.len(), 1);
        let Block::Paragraph(spans) = &blocks[0] else {
            panic!("expected one paragraph, got {:?}", blocks[0]);
        };
        assert_eq!(span_text(spans), "Plain bold italic code link");

        let style_of = |text: &str| {
            spans
                .iter()
                .find(|span| span.text.trim() == text)
                .unwrap_or_else(|| panic!("no span {text:?}"))
                .style
        };
        assert!(style_of("bold").bold);
        assert!(!style_of("bold").italic);
        assert!(style_of("italic").italic);
        assert!(style_of("code").code);
        assert!(style_of("link").link);
        assert_eq!(style_of("Plain"), InlineStyle::default());
    }

    #[test]
    fn nested_emphasis_resolves_to_one_run() {
        let blocks = parse_blocks("***both***");
        let Block::Paragraph(spans) = &blocks[0] else {
            panic!("expected a paragraph");
        };
        assert_eq!(spans.len(), 1);
        assert!(spans[0].style.bold && spans[0].style.italic);
    }

    #[test]
    fn headings_are_recognized_with_their_level() {
        let blocks = parse_blocks("# One\n\n## Two\n\n### Three\n\n#### Four");
        let levels: Vec<(u8, String)> = blocks
            .iter()
            .map(|block| match block {
                Block::Heading { level, spans } => (*level, span_text(spans)),
                other => panic!("expected a heading, got {other:?}"),
            })
            .collect();
        assert_eq!(
            levels,
            [
                (1, "One".to_string()),
                (2, "Two".to_string()),
                (3, "Three".to_string()),
                (4, "Four".to_string()),
            ]
        );
    }

    #[test]
    fn fenced_code_keeps_language_and_lines() {
        let blocks = parse_blocks("```rust\nfn main() {\n    run();\n}\n```");
        assert_eq!(
            blocks,
            [Block::Code {
                language: Some("rust".to_string()),
                text: "fn main() {\n    run();\n}".to_string(),
            }]
        );
        assert_eq!(code_label(Some("rust")), "rust");
    }

    #[test]
    fn indented_code_has_no_language_and_labelled_text() {
        let blocks = parse_blocks("    let answer = 42;\n");
        assert_eq!(
            blocks,
            [Block::Code {
                language: None,
                text: "let answer = 42;".to_string(),
            }]
        );
        assert_eq!(code_label(None), "text");
        assert_eq!(code_label(Some("")), "text");
        assert_eq!(code_label(Some("   ")), "text");
    }

    #[test]
    fn fence_info_string_keeps_only_the_language() {
        let blocks = parse_blocks("```rust title=\"demo\"\nlet x = 1;\n```");
        assert_eq!(
            blocks,
            [Block::Code {
                language: Some("rust".to_string()),
                text: "let x = 1;".to_string(),
            }]
        );
    }

    #[test]
    fn unordered_list_items_are_recognized() {
        let blocks = parse_blocks("- one\n- two\n");
        assert_eq!(blocks.len(), 1);
        let Block::List {
            ordered,
            start,
            items,
        } = &blocks[0]
        else {
            panic!("expected a list, got {:?}", blocks[0]);
        };
        assert!(!ordered);
        assert_eq!(*start, 1);
        assert_eq!(items.len(), 2);
        assert_eq!(
            items
                .iter()
                .map(|item| document_text(item))
                .collect::<Vec<_>>(),
            ["one", "two"]
        );
    }

    #[test]
    fn ordered_list_keeps_its_start_number() {
        let blocks = parse_blocks("3. three\n4. four\n");
        let Block::List {
            ordered,
            start,
            items,
        } = &blocks[0]
        else {
            panic!("expected a list, got {:?}", blocks[0]);
        };
        assert!(ordered);
        assert_eq!(*start, 3);
        assert_eq!(items.len(), 2);
    }

    #[test]
    fn nested_list_stays_inside_its_item() {
        let blocks = parse_blocks("- one\n  - nested\n- two\n");
        let Block::List { items, .. } = &blocks[0] else {
            panic!("expected a list, got {:?}", blocks[0]);
        };
        assert_eq!(items.len(), 2);
        let nested = items[0]
            .iter()
            .find_map(|block| match block {
                Block::List { items, .. } => Some(items),
                _ => None,
            })
            .expect("the first item holds the nested list");
        assert_eq!(nested.len(), 1);
        assert_eq!(document_text(&nested[0]), "nested");
    }

    #[test]
    fn blockquote_wraps_its_blocks() {
        let blocks = parse_blocks("> quoted **text**\n");
        let Block::Quote(inner) = &blocks[0] else {
            panic!("expected a quote, got {:?}", blocks[0]);
        };
        assert_eq!(inner.len(), 1);
        let Block::Paragraph(spans) = &inner[0] else {
            panic!("expected a paragraph inside the quote");
        };
        assert_eq!(span_text(spans), "quoted text");
        assert!(
            spans
                .iter()
                .any(|span| span.text == "text" && span.style.bold)
        );
    }

    #[test]
    fn thematic_break_becomes_a_rule() {
        let blocks = parse_blocks("before\n\n---\n\nafter");
        assert_eq!(blocks.len(), 3);
        assert!(matches!(blocks[1], Block::Rule));
        assert_eq!(document_text(&blocks), "beforeafter");
    }

    #[test]
    fn soft_break_becomes_a_space_and_hard_break_a_newline() {
        let blocks = parse_blocks("one\ntwo  \nthree");
        let Block::Paragraph(spans) = &blocks[0] else {
            panic!("expected a paragraph");
        };
        assert_eq!(span_text(spans), "one two\nthree");
    }

    #[test]
    fn unsupported_constructs_keep_their_text() {
        // Tables, HTML and footnote syntax are not enabled, so each arrives as
        // text; the parse must keep it and never panic.
        let source = "<div>raw html</div>\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nref[^1]";
        let blocks = parse_blocks(source);
        let text = document_text(&blocks);
        assert!(text.contains("raw html"), "lost HTML text: {text:?}");
        assert!(text.contains("| a | b |"), "lost table text: {text:?}");
        assert!(text.contains("ref[^1]"), "lost footnote text: {text:?}");
    }

    #[test]
    fn empty_and_odd_input_never_panics() {
        assert!(parse_blocks("").is_empty());
        assert!(parse_blocks("   \n\n  ").is_empty());
        assert!(!parse_blocks("```\nunclosed fence").is_empty());
        // An empty quote carries no text, and the parse still returns.
        assert!(document_text(&parse_blocks("> \n> \n")).is_empty());
    }

    #[test]
    fn task_list_markers_are_kept() {
        let blocks = parse_blocks("- [x] done\n- [ ] todo\n");
        let Block::List { items, .. } = &blocks[0] else {
            panic!("expected a list, got {:?}", blocks[0]);
        };
        assert_eq!(document_text(&items[0]), "☑ done");
        assert_eq!(document_text(&items[1]), "☐ todo");
    }

    #[test]
    fn carriage_returns_end_the_line_without_showing() {
        assert_eq!(document_text(&parse_blocks("one\r\ntwo\r\n")), "one two");
    }

    #[test]
    fn render_markdown_builds_every_block_kind_without_a_window() {
        // Building elements needs no window; only laying them out would.
        let source = "# Title\n\nBody **bold** `code` [link](https://example.com)\n\n\
                      - one\n- two\n\n1. first\n\n> quote\n\n---\n\n```rust\nfn main() {}\n```\n";
        let _element = render_markdown(source, ThemeColor::default(), |_, _, _| {});
        let _empty = render_markdown("", ThemeColor::default(), |_, _, _| {});
    }
}
