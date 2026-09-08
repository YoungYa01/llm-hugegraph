import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { LoadingState } from "./components/Ui.jsx";
import { AppRoutes } from "./routes/AppRoutes.jsx";
import { clearSession, hasSession, restoreSession, signOut, user } from "./utils/auth.js";
import { toast } from "./utils/ui.js";

export function App() {
	const navigate = useNavigate();
	const [booting, setBooting] = useState(true);
	const [account, setAccount] = useState(() => user());

	useEffect(() => {
		let active = true;
		(async () => {
			if (hasSession()) await restoreSession();
			if (!active) return;
			setAccount(user());
			setBooting(false);
		})();
		return () => {
			active = false;
		};
	}, []);

	useEffect(() => {
		function onExpired() {
			clearSession();
			setAccount(null);
			navigate("/login", { replace: true });
			toast("登录已失效，请重新登录", "error");
		}
		window.addEventListener("auth:expired", onExpired);
		return () => window.removeEventListener("auth:expired", onExpired);
	}, [navigate]);

	const logout = useCallback(async () => {
		await signOut();
		setAccount(null);
		navigate("/login", { replace: true });
	}, [navigate]);

	const authenticated = useCallback(
		(nextUser) => {
			setAccount(nextUser);
			navigate("/projects", { replace: true });
		},
		[navigate],
	);

	if (booting) return <LoadingState message="正在恢复会话…" minHeight="100vh" />;

	return (
		<AppRoutes account={account} onAuthenticated={authenticated} onLogout={logout} onAccountUpdated={setAccount} />
	);
}
