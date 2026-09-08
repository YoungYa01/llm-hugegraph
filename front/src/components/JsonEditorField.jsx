import { IconCodeStroked } from "@douyinfe/semi-icons";
import { Button, JsonViewer } from "@douyinfe/semi-ui";
import { forwardRef, useImperativeHandle, useRef } from "react";

/**
 * Semi JsonViewer wrapper for editable JSON form fields.
 * JsonViewer is intentionally used as an uncontrolled editor per Semi's API guidance.
 */
export const JsonEditorField = forwardRef(function JsonEditorField(
	{ value = "{}", height = 200, className = "", hint, showFormat = true },
	forwardedRef,
) {
	const editorRef = useRef(null);

	useImperativeHandle(
		forwardedRef,
		() => ({
			getValue: () => editorRef.current?.getValue?.() ?? value,
			format: () => editorRef.current?.format?.(),
		}),
		[value],
	);

	return (
		<div className={`architecture-json-field ${className}`.trim()}>
			{showFormat ? (
				<div className="architecture-json-actions">
					<Button
						type="tertiary"
						theme="borderless"
						size="small"
						icon={<IconCodeStroked size="small" />}
						onClick={() => editorRef.current?.format?.()}
					>
						格式化
					</Button>
				</div>
			) : null}
			<JsonViewer
				ref={editorRef}
				className="architecture-json-editor"
				width="100%"
				height={height}
				value={value}
				showSearch={false}
				options={{
					lineHeight: 20,
					autoWrap: true,
					readOnly: false,
					formatOptions: {
						tabSize: 2,
						insertSpaces: true,
						eol: "\n",
					},
				}}
			/>
			{hint ? <span className="field-hint">{hint}</span> : null}
		</div>
	);
});
