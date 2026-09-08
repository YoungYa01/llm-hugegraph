import { Checkbox, Input, Select, Button as SemiButton, TextArea } from "@douyinfe/semi-ui";
import React, { useEffect, useMemo, useState } from "react";

function buttonTheme(className = "") {
	if (className.includes("button-primary")) return { theme: "solid", type: "primary" };
	if (className.includes("button-danger")) return { theme: "light", type: "danger" };
	if (className.includes("button-ghost")) return { theme: "borderless", type: "tertiary" };
	return { theme: "light", type: "tertiary" };
}

export function AppButton({ type = "button", className = "", children, ...props }) {
	const htmlType = ["button", "submit", "reset"].includes(type) ? type : "button";
	const visual = buttonTheme(className);
	return (
		<SemiButton {...visual} {...props} htmlType={htmlType} className={className}>
			{children}
		</SemiButton>
	);
}

function useCompatValue(value, defaultValue = "") {
	const controlled = value !== undefined;
	const [inner, setInner] = useState(defaultValue ?? "");
	useEffect(() => {
		if (controlled) setInner(value ?? "");
	}, [controlled, value]);
	return [controlled ? (value ?? "") : inner, setInner, controlled];
}

export function AppInput({ onChange, className = "input", name, value, defaultValue, type, ...props }) {
	const [current, setCurrent] = useCompatValue(value, defaultValue);
	const mode = type === "password" ? "password" : props.mode;
	return (
		<>
			<Input
				{...props}
				mode={mode}
				className={className}
				value={current}
				onChange={(next) => {
					setCurrent(next);
					onChange?.({ target: { value: next } });
				}}
			/>
			{name ? <input type="hidden" name={name} value={current} /> : null}
		</>
	);
}

export function AppTextArea({ onChange, className = "input", name, value, defaultValue, ...props }) {
	const [current, setCurrent] = useCompatValue(value, defaultValue);
	return (
		<>
			<TextArea
				{...props}
				className={className}
				value={current}
				onChange={(next) => {
					setCurrent(next);
					onChange?.({ target: { value: next } });
				}}
			/>
			{name ? <input type="hidden" name={name} value={current} /> : null}
		</>
	);
}

export function AppSelect({ children, onChange, className = "select", name, value, defaultValue, ...props }) {
	const options = useMemo(
		() =>
			React.Children.toArray(children)
				.filter((child) => React.isValidElement(child))
				.map((child) => ({
					value: child.props.value,
					label: child.props.children,
					disabled: child.props.disabled,
				})),
		[children],
	);
	const fallback = defaultValue ?? options[0]?.value ?? "";
	const [current, setCurrent] = useCompatValue(value, fallback);
	return (
		<>
			<Select
				{...props}
				className={className}
				value={current}
				optionList={options}
				onChange={(next) => {
					setCurrent(next);
					onChange?.({ target: { value: next } });
				}}
			/>
			{name ? <input type="hidden" name={name} value={current} /> : null}
		</>
	);
}

export function AppCheckbox({ checked, defaultChecked, onChange, name, value = "on", ...props }) {
	const controlled = checked !== undefined;
	const [inner, setInner] = useState(Boolean(defaultChecked));
	const current = controlled ? Boolean(checked) : inner;
	return (
		<>
			<Checkbox
				{...props}
				checked={current}
				onChange={(event) => {
					const next = Boolean(event?.target?.checked ?? event);
					if (!controlled) setInner(next);
					onChange?.({ target: { checked: next, value } });
				}}
			/>
			{name && current ? <input type="hidden" name={name} value={value} /> : null}
		</>
	);
}
