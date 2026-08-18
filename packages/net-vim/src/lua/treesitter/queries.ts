// Minimal default highlight queries for the grammars shipped via
// @vscode/tree-sitter-wasm. Capture names follow Neovim's conventions so the
// shared color scheme applies. Users can supply their own full queries later.

const DEFAULT_QUERIES: Record<string, string> = {
  javascript: `
(comment) @comment
(string) @string
(template_string) @string
(number) @number
(identifier) @variable
(property_identifier) @property
(statement_identifier) @label
(function_declaration name: (identifier) @function)
(function_expression name: (identifier) @function)
(method_definition name: (property_identifier) @method)
(arrow_function) @function
(variable_declarator name: (identifier) @variable)
(member_expression property: (property_identifier) @field)
(call_expression function: (identifier) @function)
(new_expression constructor: (identifier) @constructor)
(jsx_opening_element name: (identifier) @tag)
(jsx_closing_element name: (identifier) @tag)
(object_pattern) @parameter
`,
  typescript: `
(comment) @comment
(string) @string
(template_string) @string
(number) @number
(identifier) @variable
(property_identifier) @property
(type_identifier) @type
(function_declaration name: (identifier) @function)
(function_expression name: (identifier) @function)
(method_definition name: (property_identifier) @method)
(arrow_function) @function
(interface_declaration name: (type_identifier) @type)
(type_alias_declaration name: (type_identifier) @type)
(enum_declaration name: (type_identifier) @type)
(abstract_class_declaration name: (type_identifier) @type)
(class_declaration name: (type_identifier) @type)
(variable_declarator name: (identifier) @variable)
(member_expression property: (property_identifier) @field)
(call_expression function: (identifier) @function)
(new_expression constructor: (type_identifier) @constructor)
`,
  tsx: `
(comment) @comment
(string) @string
(template_string) @string
(number) @number
(identifier) @variable
(property_identifier) @property
(type_identifier) @type
(function_declaration name: (identifier) @function)
(method_definition name: (property_identifier) @method)
(arrow_function) @function
(interface_declaration name: (type_identifier) @type)
(type_alias_declaration name: (type_identifier) @type)
(enum_declaration name: (type_identifier) @type)
(class_declaration name: (type_identifier) @type)
(variable_declarator name: (identifier) @variable)
(member_expression property: (property_identifier) @field)
(call_expression function: (identifier) @function)
(jsx_opening_element name: (identifier) @tag)
(jsx_closing_element name: (identifier) @tag)
`,
  python: `
(comment) @comment
(string) @string
(number) @number
(identifier) @variable
(function_definition name: (identifier) @function)
(class_definition name: (identifier) @type)
(parameters (identifier) @parameter)
(argument_pattern (identifier) @parameter)
(call function: (identifier) @function)
(attribute attribute: (identifier) @field)
(decorator) @decorator
(keyword_argument name: (identifier) @field)
(import_from_statement module_name: (dotted_name) @namespace)
(import_statement name: (dotted_name) @namespace)
`,
  rust: `
(line_comment) @comment
(block_comment) @comment
(string_literal) @string
(raw_string_literal) @string
(char_literal) @string
(integer_literal) @number
(float_literal) @number
(boolean_literal) @bool
(identifier) @variable
(field_identifier) @field
(type_identifier) @type
(primitive_type) @type.builtin
(lifetime . "_"?) @label
(function_item name: (identifier) @function)
(function_signature_item name: (identifier) @function)
(macro_invocation macro: (identifier) @function)
(self) @variable.builtin
(enum_item name: (type_identifier) @type)
(struct_item name: (type_identifier) @type)
(impl_item name: (type_identifier) @type)
(use_declaration) @namespace
`,
  go: `
(comment) @comment
(interpreted_string_literal) @string
(raw_string_literal) @string
(integer_literal) @number
(float_literal) @number
(identifier) @variable
(field_identifier) @field
(type_identifier) @type
(function_declaration name: (identifier) @function)
(method_declaration name: (field_identifier) @method)
(var_spec name: (identifier) @variable)
(const_spec name: (identifier) @constant)
(package_clause (package_identifier) @namespace)
(import_spec) @namespace
(selector_expression field: (field_identifier) @field)
(call_expression function: (identifier) @function)
`,
  bash: `
(comment) @comment
(string) @string
(raw_string) @string
(number) @number
(variable_name) @variable
(command_name) @function
(function_definition name: (word) @function)
(argument) @parameter
(operator) @operator
`,
  cpp: `
(comment) @comment
(string_literal) @string
(char_literal) @string
(number_literal) @number
(identifier) @identifier
(type_identifier) @type
(field_identifier) @field
(namespace_identifier) @namespace
(operator_name) @operator
(primitive_type) @type.builtin
(function_declarator declarator: (identifier) @function)
(function_definition declarator: (identifier) @function)
(preproc_include) @include
(preproc_def) @preproc
(parameter_declaration) @parameter
`,
  css: `
(comment) @comment
(string_value) @string
(integer_value) @number
(float_value) @number
(color_value) @constant
(property_name) @property
(function_name) @function
(class_selector) @type
(id_selector) @attribute
(tag_name) @tag
`,
  java: `
(line_comment) @comment
(block_comment) @comment
(string_literal) @string
(char_literal) @string
(decimal_integer_literal) @number
(decimal_floating_point_literal) @number
(identifier) @variable
(type_identifier) @type
(method_declaration name: (identifier) @method)
(constructor_declaration name: (identifier) @constructor)
(class_declaration name: (type_identifier) @type)
(interface_declaration name: (type_identifier) @type)
(enum_declaration name: (type_identifier) @type)
(record_declaration name: (type_identifier) @type)
(method_invocation name: (identifier) @function)
(field_declaration declarator: (variable_declarator) @field)
(annotation) @decorator
`,
  php: `
(comment) @comment
(string) @string
(number) @number
(function_definition name: (name) @function)
(method_declaration name: (name) @method)
(class_declaration name: (name) @type)
(interface_declaration name: (name) @type)
(enum_declaration name: (name) @type)
(namespace_definition name: (namespace_name) @namespace)
(use_statement) @include
(property_element) @field
(variable_name) @variable
(parameter) @parameter
(attribute_name) @decorator
`,
  ruby: `
(comment) @comment
(string) @string
(string_content) @string
(number) @number
(identifier) @variable
(constant) @constant
(symbol) @constant
(instance_variable) @variable
(global_variable) @variable
(class name: (constant) @type)
(module name: (constant) @type)
(method name: (identifier) @method)
(method_call method: (identifier) @function)
(block_parameter) @parameter
`,
  ini: `
(comment) @comment
(key) @property
(value) @string
(section) @label
`,
  regex: `
(comment) @comment
(character_class) @string
(anchor) @label
(literal) @string
`,
  powershell: `
(comment) @comment
(string_literal) @string
(string_start) @string
(number_literal) @number
(variable) @variable
(function_statement name: (variable) @function)
(command_name) @function
`,
  c_sharp: `
(comment) @comment
(comment_block) @comment
(string_literal) @string
(verbatim_string_literal) @string
(integer_literal) @number
(real_literal) @number
(identifier) @variable
(type_identifier) @type
(class_declaration name: (identifier) @type)
(interface_declaration name: (identifier) @type)
(struct_declaration name: (identifier) @type)
(enum_declaration name: (identifier) @type)
(namespace_declaration name: (identifier) @namespace)
(method_declaration name: (identifier) @method)
(object_creation_expression type: (type_identifier) @constructor)
(preprocessor_directive) @preproc
`,
};

export function getDefaultHighlights(lang: string): string | null {
  return DEFAULT_QUERIES[lang] ?? null;
}

export function hasDefaultHighlights(lang: string): boolean {
  return !!DEFAULT_QUERIES[lang];
}
