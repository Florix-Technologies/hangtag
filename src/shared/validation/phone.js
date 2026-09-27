// Phone number check: 10–15 digits, written with digits, spaces, + ( ) -.
export const validPhone=phone=>{const digits=String(phone||"").replace(/\D/g,"");return digits.length>=10&&digits.length<=15&&/^[+0-9 ()-]+$/.test(phone)};
