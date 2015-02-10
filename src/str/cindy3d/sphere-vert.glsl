uniform mat4 uProjectionMatrix;

uniform mat4 uModelViewMatrix;

attribute vec4 aCenter;

attribute vec4 aColor;

attribute vec4 aRelativeRadius;

varying vec3 vViewSpacePos;

varying vec3 vViewSpaceCenter;

varying vec4 vColor;

varying float vRadius;

// ----------------------------------------------------------------------------
// Vertex shader for sphere rendering
// ----------------------------------------------------------------------------
void main() {
  // Compute screen aligned coordinate system
  vec4 viewPosHom = uModelViewMatrix*aCenter;
  vViewSpaceCenter = viewPosHom.xyz / viewPosHom.w;
  vec3 dir = normalize(-vViewSpaceCenter);
  vec3 right = normalize(cross(dir, vec3(0, 1, 0)));
  vec3 up = normalize(cross(right, dir));

  // Copy attributes to varyings for use in the fragment shader
  vColor = aColor;
  vRadius = aRelativeRadius.w;

  // Cover sphere by quad in front of the real sphere
  vViewSpacePos = vViewSpaceCenter +
	vRadius*(right * aRelativeRadius.x + up * aRelativeRadius.y + dir);

  // Transform position into screen space
  gl_Position = uProjectionMatrix * vec4(vViewSpacePos, 1);
}
