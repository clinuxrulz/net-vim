use ratatui::{
    layout::Rect,
    widgets::{Block, Borders, Paragraph, Widget},
    buffer::Buffer,
    style::{Color, Style},
};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn init_panic_hook() {
    console_error_panic_hook::set_once();
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
pub enum TuiNode {
    Box {
        #[serde(default)]
        props: BoxProps,
        #[serde(default)]
        children: Vec<TuiNode>,
    },
    Text {
        #[serde(default)]
        props: TextProps,
    },
}

#[derive(Serialize, Deserialize, Debug, Default)]
pub struct BoxProps {
    pub title: Option<String>,
    #[serde(default)]
    pub border: bool,
    #[serde(default)]
    pub x: u16,
    #[serde(default)]
    pub y: u16,
    #[serde(default)]
    pub width: u16,
    #[serde(default)]
    pub height: u16,
}

#[derive(Serialize, Deserialize, Debug, Default)]
pub struct TextProps {
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub x: u16,
    #[serde(default)]
    pub y: u16,
    pub color: Option<String>,
}

#[wasm_bindgen]
pub struct Engine {
    buffer: Buffer,
    width: u16,
    height: u16,
}

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new(width: u16, height: u16) -> Self {
        Self {
            buffer: Buffer::empty(Rect::new(0, 0, width, height)),
            width,
            height,
        }
    }

    pub fn render(&mut self, root: JsValue) -> JsValue {
        let root: TuiNode = match serde_wasm_bindgen::from_value(root.clone()) {
            Ok(v) => v,
            Err(e) => {
                let json = js_sys::JSON::stringify(&root).unwrap_or_else(|_| "invalid json".into());
                web_sys::console::error_2(&JsValue::from_str(&format!("Deserialization error: {}", e)), &json);
                return JsValue::NULL;
            }
        };
        
        self.buffer.reset();
        // Start rendering at (0,0)
        self.render_node(&root, 0, 0);
        
        let cell_count = (self.width * self.height) as usize;
        let mut chars = Vec::with_capacity(cell_count);
        let mut fgs = Vec::with_capacity(cell_count * 3);
        let mut bgs = Vec::with_capacity(cell_count * 3);

        for cell in &self.buffer.content {
            let sym = cell.symbol();
            let c = match sym {
                "│" => 1,
                "─" => 2,
                "┌" => 3,
                "┐" => 4,
                "└" => 5,
                "┘" => 6,
                "├" => 7,
                "┤" => 8,
                "┬" => 9,
                "┴" => 10,
                "┼" => 11,
                "╭" => 12,
                "╮" => 13,
                "╯" => 14,
                "╰" => 15,
                _ => sym.chars().next().unwrap_or(' ') as u8,
            };
            chars.push(c);
            
            // Explicitly handle Color::Reset for FG and BG to ensure visibility
            let (fr, fg, fb) = if cell.fg == Color::Reset {
                (200, 200, 200) // Default FG is Off-White
            } else {
                color_to_rgb(cell.fg)
            };
            fgs.push(fr);
            fgs.push(fg);
            fgs.push(fb);

            let (br, bg, bb) = if cell.bg == Color::Reset {
                (20, 20, 20) // Default BG is Dark Grey
            } else {
                color_to_rgb(cell.bg)
            };
            bgs.push(br);
            bgs.push(bg);
            bgs.push(bb);
        }

        let result = RenderOutput {
            chars,
            fgs,
            bgs,
        };

        serde_wasm_bindgen::to_value(&result).unwrap()
    }

    fn render_node(&mut self, node: &TuiNode, offset_x: u16, offset_y: u16) {
        match node {
            TuiNode::Box { props, children } => {
                let x = offset_x + props.x;
                let y = offset_y + props.y;
                let rect = Rect::new(
                    x,
                    y,
                    props.width,
                    props.height
                ).intersection(Rect::new(0, 0, self.width, self.height));

                if rect.width > 0 && rect.height > 0 {
                    if props.border {
                        let mut block = Block::default().borders(Borders::ALL);
                        if let Some(title) = &props.title {
                            block = block.title(title.as_str());
                        }
                        block.render(rect, &mut self.buffer);
                    }
                    
                    // Nested children use the box's position as their origin
                    for child in children {
                        self.render_node(child, rect.x, rect.y);
                    }
                }
            }
            TuiNode::Text { props } => {
                let x = offset_x + props.x;
                let y = offset_y + props.y;
                
                if x < self.width && y < self.height {
                    let rect = Rect::new(
                        x,
                        y,
                        props.content.len() as u16,
                        1
                    ).intersection(Rect::new(0, 0, self.width, self.height));
                    
                    if rect.width > 0 {
                        let mut style = Style::default().fg(Color::White);
                        if let Some(color_str) = &props.color {
                            if let Some(color) = parse_color(color_str) {
                                style = style.fg(color);
                            }
                        }
                        let paragraph = Paragraph::new(props.content.as_str())
                            .style(style);
                        paragraph.render(rect, &mut self.buffer);
                    }
                }
            }
        }
    }
}

fn parse_color(s: &str) -> Option<Color> {
    if s.starts_with('#') && s.len() == 7 {
        let r = u8::from_str_radix(&s[1..3], 16).ok()?;
        let g = u8::from_str_radix(&s[3..5], 16).ok()?;
        let b = u8::from_str_radix(&s[5..7], 16).ok()?;
        Some(Color::Rgb(r, g, b))
    } else {
        match s.to_lowercase().as_str() {
            "white" => Some(Color::White),
            "black" => Some(Color::Black),
            "red" => Some(Color::Red),
            "green" => Some(Color::Green),
            "yellow" => Some(Color::Yellow),
            "blue" => Some(Color::Blue),
            "magenta" => Some(Color::Magenta),
            "cyan" => Some(Color::Cyan),
            "gray" => Some(Color::Gray),
            _ => None,
        }
    }
}

#[derive(Serialize)]
struct RenderOutput {
    chars: Vec<u8>,
    fgs: Vec<u8>,
    bgs: Vec<u8>,
}

fn color_to_rgb(color: Color) -> (u8, u8, u8) {
    match color {
        Color::Reset => (255, 255, 255),
        Color::Black => (0, 0, 0),
        Color::Red => (255, 0, 0),
        Color::Green => (0, 255, 0),
        Color::Yellow => (255, 255, 0),
        Color::Blue => (0, 0, 255),
        Color::Magenta => (255, 0, 255),
        Color::Cyan => (0, 255, 255),
        Color::Gray => (128, 128, 128),
        Color::DarkGray => (64, 64, 64),
        Color::LightRed => (255, 128, 128),
        Color::LightGreen => (128, 255, 128),
        Color::LightYellow => (255, 255, 128),
        Color::LightBlue => (128, 128, 255),
        Color::LightMagenta => (255, 128, 255),
        Color::LightCyan => (128, 255, 255),
        Color::White => (255, 255, 255),
        Color::Rgb(r, g, b) => (r, g, b),
        Color::Indexed(i) => (i, i, i),
    }
}
